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

// Discovery state lives at module scope. SignalRGB can rebuild the discovery
// object underneath us, and anything stored on `this` silently resets when it
// does - which showed up as the startup sweep running over and over.
const SWEEP_CHUNK = 24;
let sweepQueue = [];
let discoveryFirstRun = true;
let lastPollTime = 0;
let lastDiscoveryErrorAt = 0;
let seenResponders = new Set();
let unparsedMessages = 0;

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

// Which field of the incoming datagram object actually carried intact bytes.
// Recorded for the log so the choice is visible rather than mysterious.
let lastByteSource = "";

// Convert one candidate field into a byte array. No unwrapping here - the
// caller decides which field to try.
function bytesFromCandidate(raw) {
	if (raw === undefined || raw === null) {
		return [];
	}
	if (Array.isArray(raw)) {
		return raw.map(function(byte) { return Number(byte) & 0xff; });
	}
	// ArrayBuffer, or anything that quacks like one.
	if (typeof raw === "object" && typeof raw.byteLength === "number" && typeof raw.length !== "number") {
		try {
			return Array.from(new Uint8Array(raw)).map(function(byte) { return byte & 0xff; });
		} catch (error) {
			return [];
		}
	}
	// Typed arrays and other array-likes.
	if (typeof raw === "object" && typeof raw.length === "number") {
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

// A LIFX packet declares its own length in its first two bytes, so we can tell
// an intact copy from a mangled one. This matters because SignalRGB hands the
// same datagram over in several forms, and `data` is a UTF-8 decoded string:
// every byte above 0x7F becomes U+FFFD and multi-byte sequences collapse, so
// the array comes up short and the packet gets rejected. Try each field and
// keep the first one whose declared size actually fits.
function isSelfConsistent(bytes) {
	if (bytes.length < HEADER_SIZE) {
		return false;
	}
	const declared = bytes[0] | (bytes[1] << 8);
	return declared >= HEADER_SIZE && declared <= bytes.length;
}

function normalizeBytes(value) {
	if (value && typeof value === "object" && !Array.isArray(value) && typeof value.length !== "number") {
		const order = ["buffer", "utf16", "bytes", "payload", "data", "response"];
		let best = [];
		let bestKey = "";

		for (const key of order) {
			if (value[key] === undefined) {
				continue;
			}
			const candidate = bytesFromCandidate(value[key]);
			if (isSelfConsistent(candidate)) {
				lastByteSource = key;
				return candidate;
			}
			if (candidate.length > best.length) {
				best = candidate;
				bestKey = key;
			}
		}

		// Nested wrappers, e.g. { response: { data: ... } }.
		for (const key of ["response", "data"]) {
			const inner = value[key];
			if (inner && typeof inner === "object" && typeof inner.length !== "number") {
				const candidate = normalizeBytes(inner);
				if (isSelfConsistent(candidate)) {
					return candidate;
				}
				if (candidate.length > best.length) {
					best = candidate;
					bestKey = `${key}.${lastByteSource}`;
				}
			}
		}

		lastByteSource = bestKey || "none";
		return best;
	}

	lastByteSource = "raw";
	return bytesFromCandidate(value);
}

// Diagnostic only: describe a datagram we could not parse, so we can tell
// junk traffic apart from a light replying in a shape we reject.
function describeDatagram(value) {
	const shape = value === null ? "null" : typeof value;
	const keys = (value && typeof value === "object" && !Array.isArray(value))
		? Object.keys(value).slice(0, 12).join("/")
		: "-";
	const bytes = normalizeBytes(value);
	const hex = bytes.slice(0, 40)
		.map(function(byte) { return byte.toString(16).padStart(2, "0"); })
		.join(" ");
	const declared = bytes.length >= 2 ? getUint16LE(bytes, 0) : -1;
	const type = bytes.length >= 34 ? getUint16LE(bytes, 32) : -1;
	return `from=${remoteIp(value) || "?"} shape=${shape} keys=${keys} bytes=${bytes.length} declaredSize=${declared} type=${type} head=[${hex}]`;
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

	this.makeSocket = function(label) {
		const socket = udp.createSocket();
		socket.on("message", function(message) {
			discovery.handleIncoming(message);
		});
		socket.on("error", function(code, message) {
			discovery.handleSocketError(label, code, message);
		});
		socket.bind(0);
		return socket;
	};

	this.startSocket = function() {
		// Two sockets on purpose. The listener handles broadcasts and replies
		// from lights we already know. The prober does the subnet sweep, so the
		// ICMP blowback from empty addresses lands on a socket we can throw away
		// without losing the lights that are working.
		if (!this.socket) {
			this.socket = this.makeSocket("listener");
		}
		if (!this.probeSocket) {
			this.probeSocket = this.makeSocket("prober");
		}
	};

	// Any socket can now be torn down and rebuilt mid-flight, so never touch
	// one directly - this re-creates whatever is missing first.
	this.writeListener = function(packet, ip, port) {
		this.startSocket();
		if (!this.socket) {
			return;
		}
		try {
			this.socket.write(packet, ip, port || LIFX_PORT);
		} catch (error) {
			this.handleSocketError("listener", "write", error);
		}
	};

	this.handleSocketError = function(label, code, message) {
		const text = `${code}${message ? ` ${message}` : ""}`;

		// A reset here is just ICMP blowback from an address with nothing on
		// it. The socket is still usable, and tearing it down was actively
		// harmful: the replacement binds a new port, so every reply already in
		// flight gets delivered to a port nobody is listening on. That is what
		// was swallowing the bulbs. Log it and carry on.
		if (/reset/i.test(text)) {
			const seen = Date.now();
			if (seen - lastDiscoveryErrorAt >= 15000) {
				lastDiscoveryErrorAt = seen;
				service.log(`LIFX ${label} socket: ${text} (expected during a sweep, socket kept open)`);
			}
			return;
		}

		if (label === "prober") {
			if (this.probeSocket) {
				try { this.probeSocket.close(); } catch (error) { /* already gone */ }
				this.probeSocket = undefined;
			}
		} else if (this.socket) {
			try { this.socket.close(); } catch (error) { /* already gone */ }
			this.socket = undefined;
		}

		const now = Date.now();
		if (now - lastDiscoveryErrorAt >= 5000) {
			lastDiscoveryErrorAt = now;
			service.log(`LIFX ${label} socket: ${text} (rebuilding)`);
		}
	};

	this.Update = function() {
		if (discoveryFirstRun) {
			discoveryFirstRun = false;
			this.loadCachedDevices();
			this.scanNow();
			// Broadcast is unreliable on machines with a VPN or virtual adapter,
			// so queue one unicast sweep of every known subnet at startup.
			this.sweepSubnet("");
			return;
		}

		this.drainSweepQueue();

		if (Date.now() - lastPollTime >= this.PollInterval) {
			this.scanNow();
		}
	};

	// The sweep goes out a few probes at a time rather than 254 at once. A
	// single burst triggers a storm of ICMP replies that kills the socket
	// before any light has had a chance to answer.
	this.drainSweepQueue = function() {
		if (!sweepQueue.length) {
			return;
		}

		this.startSocket();
		const packet = buildGetService();
		const count = Math.min(SWEEP_CHUNK, sweepQueue.length);

		for (let index = 0; index < count; index++) {
			const address = sweepQueue.shift();
			if (!this.probeSocket) {
				break;
			}
			try {
				this.probeSocket.write(packet, address, LIFX_PORT);
			} catch (error) {
				// Put the address back and rebuild - the next tick retries it.
				sweepQueue.unshift(address);
				this.handleSocketError("prober", "write", error);
				break;
			}
		}

		if (!sweepQueue.length) {
			const heard = Array.from(seenResponders);
			service.log(`Subnet sweep finished. Heard from ${heard.length} address(es) this session: ${heard.length ? heard.join(", ") : "none"}.`);
		}
	};

	this.scanNow = function() {
		this.startSocket();
		lastPollTime = Date.now();

		const packet = buildGetService();

		service.log("Broadcasting LIFX GetService discovery packet.");
		this.writeListener(packet, this.UdpBroadcastAddress, this.UdpBroadcastPort);

		// Limited broadcast (255.255.255.255) is dropped by a lot of Windows
		// network stacks and consumer routers. Subnet-directed broadcast is far
		// more reliable, so send one for every subnet we already know about.
		for (const base of this.knownSubnets) {
			this.writeListener(packet, `${base}.255`);
		}

		// Re-poke anything already in the cache so it refreshes its label/IP.
		for (const [, cachedValue] of Array.from(this.cache.Entries())) {
			if (cachedValue && isIpv4(cachedValue.ip)) {
				this.writeListener(packet, cachedValue.ip);
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

		service.log(`Sweeping ${prefix}.1-254 for LIFX lights.`);

		// One directed broadcast up front - it often works on its own and costs
		// a single packet - then queue the addresses for the drip-feed.
		this.writeListener(buildGetService(), `${prefix}.255`);

		for (let host = 1; host <= 254; host++) {
			sweepQueue.push(`${prefix}.${host}`);
		}
	};

	this.sweepSubnet = function(base) {
		const raw = String(base || "").trim().replace(/\.$/, "");

		// Drop anything still queued so repeated presses don't pile up.
		sweepQueue = [];

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

		// Accept several addresses at once, separated by commas or spaces, so a
		// list copied out of a router's DHCP table can be pasted straight in.
		if (/[,\s]/.test(raw)) {
			const parts = raw.split(/[,\s]+/).filter(function(part) { return part.length; });
			for (const part of parts) {
				this.checkIP(part);
			}
			return;
		}

		// Accept a bare 3-octet prefix ("192.168.0") as a subnet sweep request.
		if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.?$/.test(raw)) {
			this.sweepSubnet(raw.replace(/\.$/, ""));
			return;
		}

		if (!isIpv4(raw)) {
			service.log(`Ignoring invalid address: "${raw}". Enter a full IP (192.168.0.50) or a subnet prefix (192.168.0) to sweep.`);
			return;
		}

		this.rememberSubnet(raw);
		service.log(`Checking LIFX device at ${raw}.`);
		this.writeListener(buildGetService(), raw);
	};

	this.Discovered = function(value) {
		this.handleIncoming(value);
	};

	this.handleIncoming = function(value) {
		const packet = parsePacket(value);
		if (!packet) {
			// Something arrived but did not look like LIFX. Worth knowing about:
			// it means the socket can hear, which is a different problem from
			// hearing nothing at all.
			unparsedMessages++;
			if (unparsedMessages <= 8) {
				service.log(`Unparsed datagram #${unparsedMessages}: ${describeDatagram(value)}`);
			} else if (unparsedMessages % 100 === 0) {
				service.log(`Heard a datagram that did not parse as LIFX (${unparsedMessages} so far).`);
			}
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

		if (!seenResponders.has(ip)) {
			seenResponders.add(ip);
			service.log(`Reply from ${ip} (message type ${packet.type}, bytes read from "${lastByteSource}").`);
		}

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
			this.writeListener(buildGetLabel(), ip);
			this.writeListener(buildGetVersion(), ip);
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
