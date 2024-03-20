import SimplePeer from "https://jspm.dev/simple-peer";
import PubNub from "https://jspm.dev/pubnub";

class Beakon {
  constructor(opts) {
    const emitter = new EventEmitter();

    this.on = (event, listener) => emitter.on(event, listener);
    this.once = (event, listener) => emitter.once(event, listener);
    this.off = (event, listener) => emitter.off(event, listener);
    this.emit = (event, data) => emitter.emit(event, data);

    this.pubnub = new PubNub(opts.pubnubConfig);
    this.peers = new Set();
    this.opts = opts;
    this.seenGossipIds = new Set();
    this.seenMessageIds = new Set();
    this.seenMessages = [];
    this.init();
    window.beakon = this;
  }

  async init() {
    this.peerId = this.opts.peerId || (await this.generateRandomSHA1Hash());
    console.log("This peer ID", this.peerId);
    this.setupListeners();
    this.announcePresence();
  }

  async generateRandomSHA1Hash() {
    const array = new Uint8Array(20);
    window.crypto.getRandomValues(array);
    const hashBuffer = await crypto.subtle.digest("SHA-1", array);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  connections() {
    return Object.keys(this.peers);
  }

  setupListeners() {
    this.pubnub.addListener({
      message: (message) => {
        const { sender, data, type, target } = message.message;
        if (sender === this.peerId) return;
        if (target && target !== this.peerId) return;

        if (this.opts.debug === true)
          console.debug("DEBUG: Received signal:", message);
        switch (type) {
          case "announce-presence":
            this.handleNewPeer(sender);
            break;
          case "signal":
            this.handleSignal(sender, JSON.parse(data));
            break;
        }
      },
    });
    this.pubnub.subscribe({ channels: ["peersChannel"] });
  }

  announcePresence() {
    this.pubnub.publish({
      channel: "peersChannel",
      message: {
        sender: this.peerId,
        type: "announce-presence",
      },
    });
  }

  handleNewPeer(peerId) {
    if (!this.peers[peerId]) {
      this.createPeer(peerId, true);
    } else {
      this.pubnub.publish({
        channel: "peersChannel",
        message: {
          sender: this.peerId,
          type: "announce-connection",
          target: peerId,
        },
      });
    }
  }

  handleSignal(peerId, signal) {
    if (!this.peers[peerId]) {
      this.createPeer(peerId, false);
    }
    if (this.peers[peerId]) {
      if (this.opts.debug === true)
        console.debug("DEBUG:", "Using existing P2P network for signaling");
      this.peers[peerId].signal(signal);
    } else {
      if (this.opts.debug === true)
        console.debug(
          "DEBUG:",
          "Failed to relay signal over P2P network; peer not found."
        );
    }
  }

  signalThroughPubNub(peerId, signal) {
    this.pubnub.publish({
      channel: "peersChannel",
      message: {
        sender: this.peerId,
        type: "signal",
        data: JSON.stringify(signal),
        target: peerId,
      },
    });
  }

  relaySignal(targetPeerId, signal) {
    Object.keys(this.peers).forEach((peerId) => {
      const peer = this.peers[peerId];
      if (peer && peer.connected) {
        peer.send(
          JSON.stringify({
            type: "relay-signal",
            target: targetPeerId,
            signal: signal,
          })
        );
      }
    });
  }

  createPeer(peerId, initiator) {
    const currentPeerCount = Object.keys(this.peers).length;
    const minPeers = this.opts.minPeers || 0;
    const softCap = this.opts.softCap || 10;
    const maxPeers = this.opts.maxPeers || 20;
    const randomThreshold =
      Math.floor(Math.random() * (softCap - minPeers + 1)) + softCap;

    if (currentPeerCount >= (randomThreshold || maxPeers)) {
      if (this.opts.debug === true)
        console.debug(
          `DEBUG: Soft max peer limit reached (${currentPeerCount}). Not adding peer:`,
          peerId
        );
      return;
    }
    if (this.opts.debug === true)
      console.debug("DEBUG: Creating peer...", { initiator, peerId });
    const peer = new SimplePeer({ initiator, trickle: true });

    peer.on("signal", (signal) => {
      this.pubnub.publish({
        channel: "peersChannel",
        message: {
          sender: this.peerId,
          type: "signal",
          data: JSON.stringify(signal),
          target: peerId,
        },
      });
    });

    peer.on("connect", () => {
      if (this.opts.debug) console.debug(`DEBUG: Connected to peer: ${peerId}`);
      this.emit("peer", { peer, state: "connected" }); // emit peer for use with other integrations
      this.seenMessages.forEach((message) => {
        // if (this.opts.debug === true)
        //   console.debug("DEBUG: Trying to send history.", message);
        // setTimeout(() => this.send(message), 150);
      });
    });

    let last;
    peer.on("data", (data) => {
      if (last === data) return;
      let parsedData;
      try {
        last = data;
        parsedData = JSON.parse(data);
        if (this.opts.debug === true) console.debug("DEBUG:", parsedData);
        if (parsedData.to && parsedData.to !== this.peerId) return;
        if (
          parsedData.senderId === this.peerId ||
          this.seenMessageIds.has(parsedData.messageId)
        ) {
          if (this.opts.debug)
            console.debug("DEBUG: Already seen message . . .");
          return;
        }
        this.addSeenMessage(parsedData);
        this.seenMessageIds.add(parsedData.messageId);
        console.log(`Data from ${parsedData.senderId}:`, parsedData);

        this.send(parsedData, parsedData.to);
      } catch (error) {
        console.error(`Error parsing data from ${peerId}:`, error);
      }
      if (
        parsedData.type === "relay-signal" &&
        parsedData.target === this.peerId
      ) {
        this.handleSignal(parsedData.sender, parsedData.signal);
      }
    });

    peer.on("close", () => {
      if (this.opts.debug === true)
        console.debug(`Disconnected from peer: ${peerId}`);
      this.emit("peer", { peerId, state: "disconnected" });
      delete this.peers[peerId];
      const peerCount = Object.keys(this.peers).length;
      if (this.opts.debug === true)
        console.debug("DEBUG: Peers in partial mesh:", peerCount);
      if (peerCount <= 1) this.reinitialize();
    });

    peer.on("error", (error) => {
      if (error.reason === "Close called") return;
      const peerCount = Object.keys(this.peers).length;
      if (this.opts.debug === true)
        console.debug(`DEBUG: Error with peer ${peerId}:`, error);
      if (peerCount <= 1) this.reinitialize();
    });

    this.peers[peerId] = peer;
  }

  addSeenMessage(message) {
    if (!this.seenMessages.includes(message)) this.seenMessages.push(message);
    if (this.seenMessages.length > this.opts.maxHistory)
      this.seenMessages.shift();
  }

  async send(data, to, type = null, retries = 0) {
    let gossipId = !data.gossipId
      ? await this.generateRandomSHA1Hash()
      : data.gossipId;

    let targetPeerIds = to;
    if (this.seenGossipIds.has(gossipId) && retries === 0) return;
    this.seenGossipIds.add(gossipId);

    let message = {
      messageId: data.messageId
        ? data.messageId
        : await this.generateRandomSHA1Hash(),
      senderId: data.senderId ? data.senderId : this.peerId,
      gossiperId: this.peerId,
      date: data.date ? data.date : new Date().getTime(),
      gossipId: gossipId,
      to: targetPeerIds,
      type: type,
      content: typeof data === "object" ? data.content : data,
    };

    if (!this.seenMessages.includes(message)) this.emit("data", message);
    this.addSeenMessage(message);

    let peersToSend = this.selectPeersToSend(data, targetPeerIds);
    if (peersToSend.length < this.minPeers)
      peersToSend = Object.keys(this.peers);

    if (this.opts.debug) console.debug("DEBUG: Gossiping to:", peersToSend);

    for (let peerId of peersToSend) {
      try {
        this.peers[peerId].send(JSON.stringify(message));
      } catch (error) {
        if (this.opts.debug === true)
          console.debug(
            `Error sending to peer. ${peerId} is no longer connected.`
          );
        delete this.peers[peerId];

        if (retries < 3) {
          if (this.opts.debug)
            console.debug(
              `DEBUG: Retrying message send (attempt ${retries + 1})`
            );
          await this.send(data, targetPeerIds, retries + 1);
          break;
        }
      }
    }
  }

  selectPeersToSend(data, targetPeerIds) {
    const peerKeys = Object.keys(this.peers);
    let filteredPeerIds = targetPeerIds
      ? peerKeys.filter(
          (peerId) =>
            targetPeerIds.includes(peerId) &&
            peerId !== this.peerId &&
            peerId !== data.senderId
        )
      : peerKeys.filter(
          (peerId) =>
            peerId !== this.peerId &&
            peerId !== data.gossiperId &&
            peerId !== data.senderId
        );

    if (filteredPeerIds.length < this.opts.minPeers) {
      const additionalPeersNeeded = this.opts.minPeers - filteredPeerIds.length;
      const availablePeers = peerKeys.filter(
        (peerId) => !filteredPeerIds.includes(peerId) && peerId !== this.peerId
      );
      const additionalPeers = this.shuffleArray(availablePeers).slice(
        0,
        additionalPeersNeeded
      );
      filteredPeerIds = filteredPeerIds.concat(additionalPeers);
    }

    if (!targetPeerIds) {
      const dynamicFanoutRatio =
        this.opts.minFanout +
        Math.random() * (this.opts.maxFanout - this.opts.minFanout);

      const fanoutCount = Math.ceil(
        filteredPeerIds.length * dynamicFanoutRatio
      );
      filteredPeerIds = this.shuffleArray(filteredPeerIds).slice(
        0,
        fanoutCount
      );
    }

    return filteredPeerIds;
  }

  shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.ceil(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  async reinitialize() {
    setTimeout(async () => {
      if (this.opts.debug) console.debug("Reinitializing beakon . . . ");
      await this.destroy();
      let opts = this.opts;
      window.beakon = null;
      new Beakon(opts);
    }, 5000);
  }

  async destroy() {
    await this.pubnub.unsubscribeAll();
    await Promise.all(Object.values(this.peers).map((peer) => peer.destroy()));
  }
}

export default Beakon;

class EventEmitter {
  constructor() {
    this.events = {};
  }

  on = (event, listener) => {
    if (!this.events[event]) {
      this.events[event] = [];
    }
    this.events[event].push(listener);
  };

  once = (event, listener) => {
    const onceWrapper = (...args) => {
      this.off(event, onceWrapper);
      listener(...args);
    };
    onceWrapper.originalListener = listener;

    this.on(event, onceWrapper);
  };

  off = (event, listener) => {
    if (!this.events[event]) {
      return;
    }
    this.events[event] = this.events[event].filter(
      (l) => l !== listener && l.originalListener !== listener
    );
  };

  emit = (event, ...args) => {
    if (!this.events[event]) {
      return;
    }
    const listeners = [...this.events[event]];
    listeners.forEach((listener) => {
      listener(...args);
    });
  };
}

async function generateAndStoreECDSAKeyPair() {
  const keyPair = await window.crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-384" },
    true,
    ["sign", "verify"]
  );
  const publicKey = await exportKey(keyPair.publicKey, "spki");
  const privateKey = await exportKey(keyPair.privateKey, "pkcs8");
  localStorage.setItem("ecdsaPublicKey", publicKey);
  localStorage.setItem("ecdsaPrivateKey", privateKey);
}

async function signMessage(message) {
  const privateKeyBase64 = localStorage.getItem("ecdsaPrivateKey");
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  return signData(privateKeyBase64, data);
}

async function verifyMessage(publicKeyBase64, message, signature) {
  const encoder = new TextEncoder();
  const data = encoder.encode(message);
  return verifySignature(publicKeyBase64, data, signature);
}

async function signData(privateKey, data) {
  const privateKeyObj = await window.crypto.subtle.importKey(
    "pkcs8",
    base64ToArrayBuffer(privateKey),
    { name: "ECDSA", namedCurve: "P-384" },
    true,
    ["sign"]
  );
  const signature = await window.crypto.subtle.sign(
    { name: "ECDSA", hash: { name: "SHA-256" } },
    privateKeyObj,
    data
  );
  return arrayBufferToBase64(signature);
}

async function verifySignature(publicKey, data, signature) {
  const publicKeyObj = await window.crypto.subtle.importKey(
    "spki",
    base64ToArrayBuffer(publicKey),
    { name: "ECDSA", namedCurve: "P-384" },
    true,
    ["verify"]
  );
  return await window.crypto.subtle.verify(
    { name: "ECDSA", hash: { name: "SHA-256" } },
    publicKeyObj,
    base64ToArrayBuffer(signature),
    data
  );
}

async function exportKey(key, format) {
  const exportedKey = await window.crypto.subtle.exportKey(format, key);
  return arrayBufferToBase64(exportedKey);
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binaryString = window.atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

async function generateSymmetricKey() {
  const key = await window.crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    true,
    ["encrypt", "decrypt"]
  );
  const keyBase64 = await exportKey(key, "raw");
  localStorage.setItem("aesKey", keyBase64);
  return key;
}

async function encryptMessage(message, key) {
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const encoder = new TextEncoder();
  const encodedMessage = encoder.encode(message);
  const encryptedContent = await window.crypto.subtle.encrypt(
    { name: "AES-GCM", iv: iv },
    key,
    encodedMessage
  );
  return {
    encryptedContent: arrayBufferToBase64(encryptedContent),
    iv: arrayBufferToBase64(iv),
  };
}

async function decryptMessage(encryptedContent, iv, key) {
  const decryptedContent = await window.crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToArrayBuffer(iv) },
    key,
    base64ToArrayBuffer(encryptedContent)
  );
  const decoder = new TextDecoder();
  return decoder.decode(decryptedContent);
}

async function importSymmetricKey(keyBase64) {
  return window.crypto.subtle.importKey(
    "raw",
    base64ToArrayBuffer(keyBase64),
    "AES-GCM",
    true,
    ["encrypt", "decrypt"]
  );
}

async function exampleUsage() {
  await generateAndStoreECDSAKeyPair();
  const symmetricKey = await generateSymmetricKey();

  const message = "Hello, Bob!";
  const signature = await signMessage(message);
  console.log("Signature:", signature);

  const { encryptedContent, iv } = await encryptMessage(message, symmetricKey);
  console.log("Encrypted Message:", encryptedContent);

  const alicePublicKeyBase64 = localStorage.getItem("ecdsaPublicKey");
  const isValid = await verifyMessage(alicePublicKeyBase64, message, signature);
  console.log("Is the signature valid?", isValid);

  const aesKeyBase64 = localStorage.getItem("aesKey");
  const aesKey = await importSymmetricKey(aesKeyBase64);
  const decryptedMessage = await decryptMessage(encryptedContent, iv, aesKey);
  console.log("Decrypted Message:", decryptedMessage);
}

exampleUsage();
