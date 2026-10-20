import udp from "@SignalRGB/udp";

export function Name() { return "LIFX"; }
export function Version() { return "0.1.3-ans"; }
export function Type() { return "network"; }
export function DeviceType() { return "wifi"; }
export function Publisher() { return "BigChiefRick"; }
export function Size() { return [1, 1]; }
export function DefaultPosition() { return [75, 70]; }
export function DefaultScale() { return 8.0; }

/* global
controller:readonly
discovery:readonly
LightingMode:readonly
forcedColor:readonly
transitionMs:readonly
powerOnWhenLinked:readonly
turnOffOnShutdown:readonly
*/

export function ControllableParameters() {
	return [
		{property:"LightingMode", group:"lighting", label:"Lighting Mode", description:"Canvas follows the active SignalRGB effect. Forced uses the color below.", type:"combobox", values:["Canvas", "Forced"], default:"Canvas"},
		{property:"forcedColor", group:"lighting", label:"Forced Color", description:"Color used when Lighting Mode is Forced.", min:"0", max:"360", type:"color", default:"#009bde"},
		{property:"transitionMs", group:"lighting", label:"Transition (ms)", description:"LIFX color transition duration. 50 ms matches the maximum 20 updates per second.", type:"number", min:"0", max:"1000", step:"10", default:"50"},
		{property:"powerOnWhenLinked", group:"settings", label:"Power on when linked", description:"Turn the light on when SignalRGB starts controlling it.", type:"boolean", default:"true"},
		{property:"turnOffOnShutdown", group:"settings", label:"Turn off when unlinked", description:"Turn the light off when SignalRGB stops controlling it.", type:"boolean", default:"false"},
	];
}

const LIFX_PORT = 56700;
const HEADER_SIZE = 36;
const MAX_SEND_RATE_MS = 50;
const COLOR_REASSERT_MS = 1000;
const DEFAULT_KELVIN = 3500;
const SOURCE_ID = Math.max(1, Math.floor(Math.random() * 0xffffffff));

const MESSAGE = Object.freeze({
	GET_SERVICE: 2,
	STATE_SERVICE: 3,
	GET_LABEL: 23,
	STATE_LABEL: 25,
	GET_VERSION: 32,
	STATE_VERSION: 33,
	SET_COLOR: 102,
	SET_POWER: 117,
});

let sequence = 0;
let deviceSocket;
let deviceSocketReady = false;
let lastColorSignature = "";
let lastColorSentAt = 0;
let lastSocketErrorAt = 0;

export function ledNames() {
	return ["Light"];
}

export function ledPositions() {
	return [[0, 0]];
}

export function Initialize() {
	device.setName(controller.name || "LIFX Light");
	device.addFeature("udp");

	deviceSocket = udp.createSocket();
	deviceSocketReady = false;

	deviceSocket.on("connection", function() {
		deviceSocketReady = true;
		device.log(`LIFX UDP connected to ${controller.ip}:${LIFX_PORT}.`);
		if (powerOnWhenLinked) {
			sendToController(buildSetPower(true, 0));
		}
	});

	deviceSocket.on("error", function(code, message) {
		logSocketError(code, message);
	});

	deviceSocket.connect(controller.ip, LIFX_PORT);

	lastColorSignature = "";
	lastColorSentAt = 0;
}

export function Render() {
	if (!deviceSocketReady) {
		device.pause(MAX_SEND_RATE_MS);
		return;
	}

	const now = Date.now();
	if (now - lastColorSentAt < MAX_SEND_RATE_MS) {
		device.pause(MAX_SEND_RATE_MS - (now - lastColorSentAt));
		return;
	}

	const rgb = LightingMode === "Forced"
		? device.createColorArray(forcedColor, 1, "Inline").slice(0, 3)
		: device.color(0, 0);

	const signature = `${rgb[0]},${rgb[1]},${rgb[2]},${transitionMs}`;
	if (signature !== lastColorSignature || now - lastColorSentAt >= COLOR_REASSERT_MS) {
		sendToController(buildSetColor(rgb, Number(transitionMs), DEFAULT_KELVIN));
		lastColorSignature = signature;
		lastColorSentAt = now;
	}

	device.pause(MAX_SEND_RATE_MS);
}

export function Shutdown() {
	if (turnOffOnShutdown && deviceSocketReady) {
		sendToController(buildSetPower(false, 0));
	}
	if (deviceSocket) {
		deviceSocket.close();
		deviceSocket = undefined;
		deviceSocketReady = false;
	}
}

function sendToController(packet) {
	if (!deviceSocket || !deviceSocketReady) {
		return;
	}
	try {
		deviceSocket.send(packet);
	} catch (error) {
		logSocketError("send", error);
	}
}

function logSocketError(code, message) {
	const now = Date.now();
	if (now - lastSocketErrorAt < 5000) {
		return;
	}
	lastSocketErrorAt = now;
	device.log(`LIFX UDP error: ${code}${message ? ` - ${message}` : ""}`);
}

function nextSequence() {
	sequence = (sequence + 1) & 0xff;
	return sequence;
}

function putUint16LE(bytes, offset, value) {
	bytes[offset] = value & 0xff;
	bytes[offset + 1] = (value >>> 8) & 0xff;
}

function putUint32LE(bytes, offset, value) {
	bytes[offset] = value & 0xff;
	bytes[offset + 1] = (value >>> 8) & 0xff;
	bytes[offset + 2] = (value >>> 16) & 0xff;
	bytes[offset + 3] = (value >>> 24) & 0xff;
}

function getUint16LE(bytes, offset) {
	return (bytes[offset] | (bytes[offset + 1] << 8)) >>> 0;
}

function getUint32LE(bytes, offset) {
	return (bytes[offset]
		| (bytes[offset + 1] << 8)
		| (bytes[offset + 2] << 16)
		| (bytes[offset + 3] << 24)) >>> 0;
}

function normalizeTarget(target) {
	if (Array.isArray(target)) {
		return target.slice(0, 8).concat(new Array(Math.max(0, 8 - target.length)).fill(0));
	}
	if (typeof target === "string") {
		const hex = target.replace(/[^a-fA-F0-9]/g, "").slice(0, 12);
		if (hex.length === 12) {
			const bytes = [];
			for (let index = 0; index < 12; index += 2) {
				bytes.push(parseInt(hex.slice(index, index + 2), 16));
			}
			return bytes.concat([0, 0]);
		}
	}
	return new Array(8).fill(0);
}

function targetId(target) {
	return normalizeTarget(target).slice(0, 6)
		.map(function(value) { return value.toString(16).padStart(2, "0"); })
		.join("");
}

function buildPacket(type, target, payload, tagged, responseRequired) {
	const body = payload || [];
	const bytes = new Array(HEADER_SIZE + body.length).fill(0);

	putUint16LE(bytes, 0, bytes.length);
	putUint16LE(bytes, 2, 0x1400 | (tagged ? 0x2000 : 0));
	putUint32LE(bytes, 4, SOURCE_ID);

	const address = normalizeTarget(target);
	for (let index = 0; index < 8; index++) {
		bytes[8 + index] = address[index];
	}

	bytes[22] = responseRequired ? 1 : 0;
	bytes[23] = nextSequence();
	putUint16LE(bytes, 32, type);

	for (let index = 0; index < body.length; index++) {
		bytes[HEADER_SIZE + index] = body[index] & 0xff;
	}

	return bytes;
}

function buildGetService() {
	return buildPacket(MESSAGE.GET_SERVICE, [], [], true, true);
}

function buildGetLabel() {
	return buildPacket(MESSAGE.GET_LABEL, [], [], true, true);
}

function buildGetVersion() {
	return buildPacket(MESSAGE.GET_VERSION, [], [], true, true);
}

function buildSetPower(on, duration) {
	const payload = new Array(6).fill(0);
	putUint16LE(payload, 0, on ? 0xffff : 0);
	putUint32LE(payload, 2, Math.max(0, Number(duration) || 0));
	return buildPacket(MESSAGE.SET_POWER, [], payload, true, false);
}

function rgbToHsbk(rgb, kelvin) {
	const red = Math.max(0, Math.min(255, Number(rgb[0]) || 0)) / 255;
	const green = Math.max(0, Math.min(255, Number(rgb[1]) || 0)) / 255;
	const blue = Math.max(0, Math.min(255, Number(rgb[2]) || 0)) / 255;

	const maximum = Math.max(red, green, blue);
	const minimum = Math.min(red, green, blue);
	const delta = maximum - minimum;

	let hue = 0;
	if (delta !== 0) {
		if (maximum === red) {
			hue = 60 * (((green - blue) / delta) % 6);
		} else if (maximum === green) {
			hue = 60 * (((blue - red) / delta) + 2);
		} else {
			hue = 60 * (((red - green) / delta) + 4);
		}
	}
	if (hue < 0) {
		hue += 360;
	}

	return {
		hue: Math.round((hue / 360) * 65535),
		saturation: maximum === 0 ? 0 : Math.round((delta / maximum) * 65535),
		brightness: Math.round(maximum * 65535),
		kelvin: Math.max(1500, Math.min(9000, Number(kelvin) || DEFAULT_KELVIN)),
	};
}

function buildSetColor(rgb, duration, kelvin) {
	const hsbk = rgbToHsbk(rgb, kelvin);
	const payload = new Array(13).fill(0);
	putUint16LE(payload, 1, hsbk.hue);
	putUint16LE(payload, 3, hsbk.saturation);
	putUint16LE(payload, 5, hsbk.brightness);
	putUint16LE(payload, 7, hsbk.kelvin);
	putUint32LE(payload, 9, Math.max(0, Number(duration) || 0));
	return buildPacket(MESSAGE.SET_COLOR, [], payload, true, false);
}

function normalizeBytes(value) {
	let raw = value;
	if (raw && raw.response !== undefined) {
		raw = raw.response;
	}
	if (raw && raw.data !== undefined) {
		raw = raw.data;
	}
	if (Array.isArray(raw)) {
		return raw.map(function(byte) { return Number(byte) & 0xff; });
	}
	if (raw && typeof raw.length === "number" && typeof raw !== "string") {
		return Array.from(raw).map(function(byte) { return Number(byte) & 0xff; });
	}
	if (typeof raw === "string") {
		if (/^\s*\d+(?:\s*,\s*\d+)*\s*$/.test(raw)) {
			return raw.split(",").map(function(byte) { return Number(byte.trim()) & 0xff; });
		}
		return Array.from(raw).map(function(character) { return character.charCodeAt(0) & 0xff; });
	}
	return [];
}

function parsePacket(value) {
	const bytes = normalizeBytes(value);
	if (bytes.length < HEADER_SIZE) {
		return undefined;
	}

	const declaredSize = getUint16LE(bytes, 0);
	if (declaredSize < HEADER_SIZE || declaredSize > bytes.length) {
		return undefined;
	}

	const target = bytes.slice(8, 16);
	return {
		bytes: bytes.slice(0, declaredSize),
		type: getUint16LE(bytes, 32),
		target,
		id: targetId(target),
	};
}

function readLabel(bytes) {
	const labelBytes = bytes.slice(HEADER_SIZE, HEADER_SIZE + 32);
	const zero = labelBytes.indexOf(0);
	const content = zero >= 0 ? labelBytes.slice(0, zero) : labelBytes;

	let encoded = "";
	for (const byte of content) {
		encoded += `%${byte.toString(16).padStart(2, "0")}`;
	}
	try {
		return decodeURIComponent(encoded);
	} catch (error) {
		return content.map(function(byte) { return String.fromCharCode(byte); }).join("");
	}
}

function productName(product) {
	if (Number(product) === 91) {
		return "LIFX Color 800lm";
	}
	return product ? `LIFX Light (product ${product})` : "LIFX Light";
}

function remoteIp(value, fallback) {
	if (!value || typeof value !== "object") {
		return fallback;
	}
	if (value.ip) {
		return value.ip;
	}
	if (value.address && typeof value.address === "string") {
		return value.address;
	}
	if (value.remoteAddress && value.remoteAddress.address) {
		return value.remoteAddress.address;
	}
	// Extra shapes seen across SignalRGB builds.
	if (typeof value.remoteAddress === "string") {
		return value.remoteAddress;
	}
	if (value.host && typeof value.host === "string") {
		return value.host;
	}
	if (value.from && typeof value.from === "string") {
		return value.from;
	}
	if (value.sender && typeof value.sender === "string") {
		return value.sender;
	}
	return fallback;
}

function isIpv4(value) {
	return /^((25[0-5]|2[0-4]\d|1?\d?\d)(\.|$)){4}$/.test(String(value || "").trim());
}

function controllerIdForIp(ipAddress) {
	const ip = String(ipAddress || "").trim();
	if (!isIpv4(ip)) {
		return undefined;
	}
	return `lifx-${ip.replace(/\./g, "-")}`;
}

function subnetBase(ipAddress) {
	const ip = String(ipAddress || "").trim();
	const parts = ip.split(".");
	if (parts.length < 3) {
		return undefined;
	}
	const base = parts.slice(0, 3).join(".");
	return isIpv4(`${base}.1`) ? base : undefined;
}

export function DiscoveryService() {
	this.IconUrl = "";
	this.UdpBroadcastAddress = "255.255.255.255";
	this.UdpBroadcastPort = LIFX_PORT;
	this.UdpListenPort = 0;
	this.PollInterval = 15000;
	this.lastPollTime = 0;
	this.firstRun = true;
	this.socket = undefined;
	this.cache = new DeviceCache();
	this.controllers = new Map();
	this.announcedControllers = new Set();
	this.knownSubnets = new Set();
	this.unresolvedReplies = 0;

	this.self = function() {
		return (typeof discovery !== "undefined" && discovery) ? discovery : this;
	};

	this.Initialize = function() {
		service.log("Initializing LIFX LAN discovery on UDP 56700.");
		this.startSocket();
	};

	this.startSocket = function() {
		if (this.socket) {
			return;
		}
		this.socket = udp.createSocket();
		this.socket.on("message", function(message) {
			discovery.handleIncoming(message);
		});
		this.socket.on("error", function(code, message) {
			service.log(`LIFX discovery UDP error: ${code}${message ? ` - ${message}` : ""}`);
		});
		this.socket.bind(0);
	};

	this.Update = function() {
		if (this.firstRun) {
			this.loadCachedDevices();
			this.firstRun = false;
			this.scanNow();
			// Broadcast is unreliable on machines with a VPN or virtual adapter,
			// so do one unicast sweep of every known subnet at startup. Unicast
			// routes per-packet and reaches lights broadcast never finds.
			this.sweepSubnet("");
			return;
		}
		if (Date.now() - this.lastPollTime >= this.PollInterval) {
			this.scanNow();
		}
	};

	this.scanNow = function() {
		this.startSocket();
		this.lastPollTime = Date.now();

		const packet = buildGetService();

		service.log("Broadcasting LIFX GetService discovery packet.");
		this.socket.write(packet, this.UdpBroadcastAddress, this.UdpBroadcastPort);

		// Limited broadcast (255.255.255.255) is dropped by a lot of Windows
		// network stacks and consumer routers. Subnet-directed broadcast is far
		// more reliable, so send one for every subnet we already know about.
		for (const base of this.knownSubnets) {
			this.socket.write(packet, `${base}.255`, LIFX_PORT);
		}

		// Re-poke anything already in the cache so it refreshes its label/IP.
		for (const [, cachedValue] of Array.from(this.cache.Entries())) {
			if (cachedValue && isIpv4(cachedValue.ip)) {
				this.socket.write(packet, cachedValue.ip, LIFX_PORT);
			}
		}
	};

	// Every subnet we have any evidence for: ones we've seen replies from, plus
	// anything sitting in the cache from a previous session.
	this.collectKnownSubnets = function() {
		const found = new Set(this.knownSubnets);
		for (const [, cachedValue] of Array.from(this.cache.Entries())) {
			const base = cachedValue ? subnetBase(cachedValue.ip) : undefined;
			if (base) {
				found.add(base);
			}
		}
		return Array.from(found);
	};

	this.sweepPrefix = function(prefix) {
		this.startSocket();
		this.knownSubnets.add(prefix);

		const packet = buildGetService();
		service.log(`Sweeping ${prefix}.1-254 for LIFX lights.`);

		this.socket.write(packet, `${prefix}.255`, LIFX_PORT);
		for (let host = 1; host <= 254; host++) {
			this.socket.write(packet, `${prefix}.${host}`, LIFX_PORT);
		}
	};

	this.sweepSubnet = function(base) {
		const raw = String(base || "").trim().replace(/\.$/, "");

		// No text typed: sweep whatever subnets we already know about. With a
		// light already linked that is always the right answer, so the button
		// works on its own.
		if (!raw) {
			const targets = this.collectKnownSubnets();
			if (!targets.length) {
				service.log("Nothing to sweep yet - type a subnet like 192.168.0 and press Sweep Subnet.");
				return;
			}
			for (const prefix of targets) {
				this.sweepPrefix(prefix);
			}
			return;
		}

		const prefix = subnetBase(`${raw}.1`) || subnetBase(raw);
		if (!prefix) {
			service.log(`Cannot sweep "${raw}" - expected something like 192.168.0`);
			return;
		}

		this.sweepPrefix(prefix);
	};

	this.rememberSubnet = function(ipAddress) {
		const base = subnetBase(ipAddress);
		if (base) {
			this.knownSubnets.add(base);
		}
	};

	this.checkIP = function(ipAddress) {
		const raw = String(ipAddress || "").trim();

		// Accept a bare 3-octet prefix ("192.168.0") as a subnet sweep request.
		if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.?$/.test(raw)) {
			this.sweepSubnet(raw.replace(/\.$/, ""));
			return;
		}

		if (!isIpv4(raw)) {
			service.log(`Ignoring invalid address: "${raw}". Enter a full IP (192.168.0.50) or a subnet prefix (192.168.0) to sweep.`);
			return;
		}

		this.startSocket();
		this.rememberSubnet(raw);
		service.log(`Checking LIFX device at ${raw}.`);
		this.socket.write(buildGetService(), raw, LIFX_PORT);
	};

	this.Discovered = function(value) {
		this.handleIncoming(value);
	};

	this.handleIncoming = function(value) {
		const packet = parsePacket(value);
		if (!packet) {
			return;
		}

		const ip = remoteIp(value);
		const id = controllerIdForIp(ip);
		if (!id) {
			// Previously this dropped the reply in total silence, which made a
			// light that answered look like a light that never existed.
			this.unresolvedReplies++;
			if (this.unresolvedReplies <= 5 || this.unresolvedReplies % 50 === 0) {
				service.log(`Got a LIFX reply (type ${packet.type}) with no readable source IP - ignoring. Count: ${this.unresolvedReplies}.`);
			}
			return;
		}

		this.rememberSubnet(ip);

		const existing = this.cache.Get(id) || {};
		const controller = this.getController(id);

		if (packet.type === MESSAGE.STATE_SERVICE) {
			const data = {
				id,
				ip,
				port: LIFX_PORT,
				name: existing.name || `LIFX ${ip}`,
				vendor: existing.vendor,
				product: existing.product,
				model: existing.model || "LIFX Light",
				paired: existing.paired === true,
			};
			this.upsertController(data);
			this.socket.write(buildGetLabel(), ip, LIFX_PORT);
			this.socket.write(buildGetVersion(), ip, LIFX_PORT);
			return;
		}

		if (!controller && !existing.id) {
			return;
		}

		const data = Object.assign({}, existing, controller || {}, {
			id,
			ip,
			port: LIFX_PORT,
		});

		if (packet.type === MESSAGE.STATE_LABEL && packet.bytes.length >= 68) {
			data.name = readLabel(packet.bytes) || data.name;
		}

		// StateVersion is 44 bytes on current firmware (vendor + product) and 48
		// on older firmware that still sent the trailing version field. The old
		// >= 48 test silently discarded every modern reply.
		if (packet.type === MESSAGE.STATE_VERSION && packet.bytes.length >= 44) {
			data.vendor = getUint32LE(packet.bytes, 36);
			data.product = getUint32LE(packet.bytes, 40);
			data.model = productName(data.product);
		}

		this.upsertController(data);
	};

	this.getController = function(id) {
		return this.controllers.get(id) || service.getController(id);
	};

	// QML hands these callbacks a plain id string. Older builds of this add-on
	// passed the whole controller object across the QML/JS boundary, where it
	// arrived as undefined - link() then threw on .id and remove() silently
	// returned. Accept either shape so both paths work.
	this.resolveId = function(value) {
		if (typeof value === "string") {
			return value;
		}
		if (value && typeof value.id === "string") {
			return value.id;
		}
		return undefined;
	};

	this.upsertController = function(value) {
		let controller = this.getController(value.id);
		if (!controller) {
			controller = new LifxController(value);
			service.addController(controller);
		} else {
			controller.updateWithValue(value);
		}
		this.controllers.set(value.id, controller);
		this.cacheController(controller);
		return controller;
	};

	this.announceOnce = function(controller) {
		if (!controller || !controller.paired || this.announcedControllers.has(controller.id)) {
			return;
		}
		service.announceController(controller);
		this.announcedControllers.add(controller.id);
	};

	this.loadCachedDevices = function() {
		for (const [cachedId, cachedValue] of Array.from(this.cache.Entries())) {
			const value = Object.assign({}, cachedValue);
			const migratedId = controllerIdForIp(value.ip);
			if (!migratedId) {
				continue;
			}
			if (cachedId !== migratedId) {
				const legacyController = service.getController(cachedId);
				if (legacyController) {
					service.suppressController(legacyController);
					service.removeController(legacyController);
				}
				this.cache.Remove(cachedId);
				value.id = migratedId;
				value.port = LIFX_PORT;
			}
			this.rememberSubnet(value.ip);
			const controller = this.upsertController(value);
			this.announceOnce(controller);
			if (value.ip) {
				this.checkIP(value.ip);
			}
		}
	};

	this.link = function(target) {
		const self = this.self();
		const id = self.resolveId(target);
		if (!id) {
			service.log("Link was called without a usable device id - ignoring.");
			return;
		}

		const controller = self.getController(id);
		if (!controller) {
			service.log(`Link failed: no known device with id ${id}.`);
			return;
		}

		controller.paired = true;
		service.updateController(controller);
		self.announceOnce(controller);
		self.cacheController(controller);
		service.log(`Linked ${controller.name} at ${controller.ip}.`);
	};

	this.unlink = function(target) {
		const self = this.self();
		const id = self.resolveId(target);
		if (!id) {
			service.log("Unlink was called without a usable device id - ignoring.");
			return;
		}

		const controller = self.getController(id);
		if (!controller) {
			return;
		}

		controller.paired = false;
		service.updateController(controller);
		service.suppressController(controller);
		self.announcedControllers.delete(controller.id);
		self.cacheController(controller);
		service.log(`Unlinked ${controller.name}.`);
	};

	this.remove = function(target) {
		const self = this.self();
		const id = self.resolveId(target);
		if (!id) {
			service.log("Remove was called without a usable device id - ignoring.");
			return;
		}

		const controller = self.getController(id);
		if (controller) {
			service.suppressController(controller);
			service.removeController(controller);
		}
		self.controllers.delete(id);
		self.announcedControllers.delete(id);
		self.cache.Remove(id);
		service.log(`Removed ${id}.`);
	};

	this.purgeCache = function() {
		this.cache.Purge();
	};

	this.cacheController = function(value) {
		this.cache.Add(value.id, {
			id: value.id,
			ip: value.ip,
			port: LIFX_PORT,
			name: value.name,
			vendor: value.vendor,
			product: value.product,
			model: value.model,
			paired: value.paired === true,
		});
	};
}

class LifxController {
	constructor(value) {
		this.id = value.id;
		this.ip = value.ip;
		this.port = LIFX_PORT;
		this.name = value.name || `LIFX ${value.ip}`;
		this.vendor = value.vendor;
		this.product = value.product;
		this.model = value.model || productName(value.product);
		this.paired = value.paired === true;
	}

	updateWithValue(value) {
		this.ip = value.ip || this.ip;
		this.port = LIFX_PORT;
		this.name = value.name || this.name;
		this.vendor = value.vendor === undefined ? this.vendor : value.vendor;
		this.product = value.product === undefined ? this.product : value.product;
		this.model = value.model || this.model || productName(this.product);
		this.paired = value.paired === undefined ? this.paired : value.paired === true;
		service.updateController(this);
	}
}

class DeviceCache {
	constructor() {
		this.storageId = "lifxDevices";
		this.storageKey = "cache";
		this.values = new Map();
		this.Load();
	}

	Add(key, value) {
		this.values.set(key, value);
		this.Persist();
	}

	Remove(key) {
		this.values.delete(key);
		this.Persist();
	}

	Get(key) {
		return this.values.get(key);
	}

	Entries() {
		return this.values.entries();
	}

	Load() {
		const stored = service.getSetting(this.storageId, this.storageKey);
		if (stored === undefined) {
			return;
		}
		try {
			this.values = new Map(JSON.parse(stored));
		} catch (error) {
			service.log(`Unable to read the LIFX device cache: ${error}`);
		}
	}

	Persist() {
		service.saveSetting(this.storageId, this.storageKey, JSON.stringify(Array.from(this.values.entries())));
	}

	Purge() {
		this.values.clear();
		service.removeSetting(this.storageId, this.storageKey);
	}
}
