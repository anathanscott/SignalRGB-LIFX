import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../LIFX.js", import.meta.url), "utf8")
	.replace(/^import udp from "@SignalRGB\/udp";\s*/m, "")
	.replace(/\bexport\s+/g, "");

const controllers = new Map();
const announcedControllers = [];
const context = vm.createContext({
	Array,
	Date,
	JSON,
	Map,
	Math,
	Number,
	Object,
	String,
	decodeURIComponent,
	parseInt,
	service: {
		addController: (controller) => controllers.set(controller.id, controller),
		announceController: (controller) => announcedControllers.push(controller.id),
		getController: (id) => controllers.get(id),
		getSetting: () => undefined,
		log: () => {},
		removeController: (controller) => controllers.delete(controller.id),
		removeSetting: () => {},
		saveSetting: () => {},
		suppressController: () => {},
		updateController: () => {},
	},
	udp: {
		createSocket: () => ({
			bind: () => {},
			on: () => {},
			write: () => {},
		}),
	},
});

vm.runInContext(`${source}\nthis.protocol = { DiscoveryService, MESSAGE, buildGetService, buildGetLabel, buildGetVersion, buildSetColor, buildSetPower, controllerIdForIp, getUint16LE, getUint32LE, normalizeTarget, parsePacket, readLabel, rgbToHsbk, targetId };`, context);
const protocol = context.protocol;

function createRuntimeHarness() {
	const sockets = [];
	const logs = [];
	const runtimeContext = vm.createContext({
		Array,
		Date,
		JSON,
		Map,
		Math,
		Number,
		Object,
		String,
		decodeURIComponent,
		parseInt,
		controller: {ip: "192.0.2.10", name: "Test LIFX"},
		device: {
			addFeature: () => {},
			color: () => [12, 34, 56],
			createColorArray: () => [12, 34, 56],
			log: (message) => logs.push(message),
			pause: () => {},
			setName: () => {},
		},
		forcedColor: "#0c2238",
		LightingMode: "Canvas",
		powerOnWhenLinked: false,
		transitionMs: 50,
		turnOffOnShutdown: false,
		udp: {
			createSocket: () => {
				const socket = {
					connectedTo: undefined,
					handlers: {},
					sent: [],
					close: () => {},
					connect: (ip, port) => { socket.connectedTo = {ip, port}; },
					on: (event, callback) => { socket.handlers[event] = callback; },
					send: (packet) => socket.sent.push(packet),
				};
				sockets.push(socket);
				return socket;
			},
		},
	});

	vm.runInContext(`${source}\nthis.runtime = { Initialize, Render, Shutdown };`, runtimeContext);
	return {logs, runtime: runtimeContext.runtime, sockets};
}

test("builds a tagged GetService packet", () => {
	const packet = protocol.buildGetService();
	assert.equal(packet.length, 36);
	assert.equal(protocol.getUint16LE(packet, 0), 36);
	assert.equal(protocol.getUint16LE(packet, 2), 0x3400);
	assert.equal(packet[22], 1);
	assert.equal(protocol.getUint16LE(packet, 32), protocol.MESSAGE.GET_SERVICE);
	assert.deepEqual(packet.slice(8, 16), new Array(8).fill(0));
});

test("starts canvas rendering from SignalRGB's connection callback", () => {
	const harness = createRuntimeHarness();
	harness.runtime.Initialize();
	const socket = harness.sockets[0];

	assert.deepEqual(socket.connectedTo, {ip: "192.0.2.10", port: 56700});
	assert.equal(typeof socket.handlers.connection, "function");
	assert.equal(socket.handlers.connected, undefined);
	harness.runtime.Render();
	assert.equal(socket.sent.length, 0);

	socket.handlers.connection();
	harness.runtime.Render();
	assert.equal(socket.sent.length, 1);
	assert.equal(protocol.getUint16LE(socket.sent[0], 32), protocol.MESSAGE.SET_COLOR);
	assert.match(harness.logs[0], /UDP connected/);
});

test("normalizes a LIFX serial into the eight-byte target", () => {
	assert.deepEqual(
		Array.from(protocol.normalizeTarget("d0:73:d5:00:11:22")),
		[0xd0, 0x73, 0xd5, 0x00, 0x11, 0x22, 0, 0],
	);
	assert.equal(protocol.targetId("d0:73:d5:00:11:22"), "d073d5001122");
});

test("converts RGB primary colors and black to LIFX HSBK", () => {
	assert.deepEqual({...protocol.rgbToHsbk([255, 0, 0], 3500)}, {
		hue: 0,
		saturation: 65535,
		brightness: 65535,
		kelvin: 3500,
	});
	assert.deepEqual({...protocol.rgbToHsbk([0, 255, 0], 3500)}, {
		hue: 21845,
		saturation: 65535,
		brightness: 65535,
		kelvin: 3500,
	});
	assert.equal(protocol.rgbToHsbk([0, 0, 0], 3500).brightness, 0);
});

test("builds SetColor with the documented payload layout", () => {
	const packet = protocol.buildSetColor([255, 0, 0], 50, 3500);
	assert.equal(packet.length, 49);
	assert.equal(protocol.getUint16LE(packet, 2), 0x3400);
	assert.deepEqual(Array.from(packet.slice(8, 16)), new Array(8).fill(0));
	assert.equal(protocol.getUint16LE(packet, 32), protocol.MESSAGE.SET_COLOR);
	assert.equal(protocol.getUint16LE(packet, 37), 0);
	assert.equal(protocol.getUint16LE(packet, 39), 65535);
	assert.equal(protocol.getUint16LE(packet, 41), 65535);
	assert.equal(protocol.getUint16LE(packet, 43), 3500);
	assert.equal(protocol.getUint32LE(packet, 45), 50);
});

test("builds SetPower without requesting a response", () => {
	const packet = protocol.buildSetPower(true, 250);
	assert.equal(packet.length, 42);
	assert.equal(protocol.getUint16LE(packet, 2), 0x3400);
	assert.deepEqual(Array.from(packet.slice(8, 16)), new Array(8).fill(0));
	assert.equal(packet[22], 0);
	assert.equal(protocol.getUint16LE(packet, 32), protocol.MESSAGE.SET_POWER);
	assert.equal(protocol.getUint16LE(packet, 36), 65535);
	assert.equal(protocol.getUint32LE(packet, 38), 250);
});

test("builds tagged wildcard metadata requests for unicast discovery follow-up", () => {
	for (const packet of [protocol.buildGetLabel(), protocol.buildGetVersion()]) {
		assert.equal(protocol.getUint16LE(packet, 2), 0x3400);
		assert.deepEqual(Array.from(packet.slice(8, 16)), new Array(8).fill(0));
		assert.equal(packet[22], 1);
	}
});

test("creates a stable SignalRGB controller id from the responder IPv4 address", () => {
	assert.equal(protocol.controllerIdForIp("192.168.1.42"), "lifx-192-168-1-42");
	assert.equal(protocol.controllerIdForIp("not-an-ip"), undefined);
});

test("repeated discovery updates add and announce one controller on fixed port 56700", () => {
	controllers.clear();
	announcedControllers.length = 0;
	const discovery = new protocol.DiscoveryService();
	discovery.startSocket();
	const packet = protocol.buildGetService();
	packet.splice(8, 8, ...protocol.normalizeTarget("d073d5001122"));
	packet[32] = protocol.MESSAGE.STATE_SERVICE;
	packet[33] = 0;
	packet.push(1, 0x7c, 0xfd, 0x00, 0x00);
	packet[0] = packet.length;
	packet[1] = 0;
	const response = {response: packet.join(","), ip: "192.168.1.42"};

	discovery.handleIncoming(response);
	discovery.link({id: "lifx-192-168-1-42"});
	discovery.handleIncoming(response);
	discovery.handleIncoming(response);

	assert.equal(controllers.size, 1);
	assert.equal(controllers.get("lifx-192-168-1-42").port, 56700);
	assert.deepEqual(announcedControllers, ["lifx-192-168-1-42"]);
});

test("parses StateService packets from arrays and comma strings", () => {
	const packet = protocol.buildGetService();
	packet.splice(8, 8, ...protocol.normalizeTarget("d073d5001122"));
	packet[32] = protocol.MESSAGE.STATE_SERVICE;
	packet[33] = 0;
	packet.push(1, 0x7c, 0xdd, 0x00, 0x00);
	packet[0] = packet.length;
	packet[1] = 0;

	const parsedArray = protocol.parsePacket(packet);
	const parsedString = protocol.parsePacket({response: packet.join(",")});
	assert.equal(parsedArray.type, protocol.MESSAGE.STATE_SERVICE);
	assert.equal(parsedArray.id, "d073d5001122");
	assert.equal(protocol.getUint32LE(parsedArray.bytes, 37), 56700);
	assert.equal(parsedString.id, parsedArray.id);
});

test("decodes a UTF-8 StateLabel", () => {
	const packet = protocol.buildGetLabel("d073d5001122");
	packet[32] = protocol.MESSAGE.STATE_LABEL;
	packet[33] = 0;
	const label = Array.from(Buffer.from("Office Lämp", "utf8"));
	packet.push(...label, ...new Array(32 - label.length).fill(0));
	packet[0] = packet.length;
	assert.equal(protocol.readLabel(packet), "Office Lämp");
});
