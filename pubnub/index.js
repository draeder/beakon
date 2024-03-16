import SimplePeer from "https://jspm.dev/simple-peer";
import PubNub from "https://jspm.dev/pubnub";

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

async function generateAndStoreKeyPair() {
  const keyPair = await window.crypto.subtle.generateKey(
    {
      name: "RSA-OAEP",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: { name: "SHA-256" },
    },
    true,
    ["encrypt", "decrypt"]
  );

  const publicKeyBase64 = await exportKey(keyPair.publicKey, "spki");
  const privateKeyBase64 = await exportKey(keyPair.privateKey, "pkcs8");

  localStorage.setItem("beakon-pubkey", publicKeyBase64);
  localStorage.setItem("beakon-privkey", privateKeyBase64);
}

async function exportKey(key, format) {
  const exportedKey = await window.crypto.subtle.exportKey(format, key);
  return arrayBufferToBase64(exportedKey);
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

function base64ToArrayBuffer(base64) {
  const binaryString = window.atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

async function importPublicKey(base64Key) {
  const keyBuffer = base64ToArrayBuffer(base64Key);
  return window.crypto.subtle.importKey(
    "spki",
    keyBuffer,
    {
      name: "RSA-OAEP",
      hash: { name: "SHA-256" },
    },
    true,
    ["encrypt"]
  );
}

async function importPrivateKey(base64Key) {
  const keyBuffer = base64ToArrayBuffer(base64Key);
  return window.crypto.subtle.importKey(
    "pkcs8",
    keyBuffer,
    {
      name: "RSA-OAEP",
      hash: { name: "SHA-256" },
    },
    true,
    ["decrypt"]
  );
}

generateAndStoreKeyPair();

class Beakon {
  constructor(opts) {
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
    // This is executed by an existing peer when it receives a signal via PubNub
    if (!this.peers[peerId]) {
      this.createPeer(peerId, false); // false indicating this peer is not the initiator
    }
    // Direct signaling through the P2P connection if it exists
    if (this.peers[peerId]) {
      this.peers[peerId].signal(signal);
    } else {
      // If for some reason the P2P connection doesn't exist, log an error or handle accordingly
      console.error("Failed to relay signal over P2P network; peer not found.");
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
    // Example: Relay signal to all connected peers
    Object.keys(this.peers).forEach((peerId) => {
      const peer = this.peers[peerId];
      if (peer && peer.connected) {
        // Send a signaling message through the peer data channel
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
      this.seenMessages.forEach((message) => {
        console.debug("DEBUG: Trying to send history.", message);
        setTimeout(() => {
          this.send(message);
        }, 150);
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

        this.send(parsedData);
      } catch (error) {
        console.error(`Error parsing data from ${peerId}:`, error);
      }
      // Add handling for relayed signaling messages
      if (
        parsedData.type === "relay-signal" &&
        parsedData.target === this.peerId
      ) {
        // If this peer is the target, process the relayed signal
        this.handleSignal(parsedData.sender, parsedData.signal);
      }
    });

    peer.on("close", () => {
      console.debug(`Disconnected from peer: ${peerId}`);
      delete this.peers[peerId];
      const peerCount = Object.keys(this.peers).length;
      if (this.opts.debug === true)
        console.debug("Peers in partial mesh:", peerCount);
      if (peerCount <= 1) this.reinitialize();
    });

    peer.on("error", (error) => {
      if (error.reason === "Close called") return;
      const peerCount = Object.keys(this.peers).length;
      if (this.opts.debug === true)
        console.debug(`Error with peer ${peerId}:`, error);
      if (peerCount <= 1) this.reinitialize();
    });

    this.peers[peerId] = peer;
  }

  addSeenMessage(message) {
    if (!this.seenMessages.includes(message)) this.seenMessages.push(message);
    if (this.seenMessages.length > this.opts.maxHistory)
      this.seenMessages.shift();
  }

  async send(data, targetPeerIds = null, retries = 0) {
    let gossipId = !data.gossipId
      ? await this.generateRandomSHA1Hash()
      : data.gossipId;

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
      content: typeof data === "object" ? data.content : data,
    };

    this.addSeenMessage(message);

    let peersToSend = this.selectPeersToSend(data, targetPeerIds);
    if (peersToSend.length < 1) peersToSend = Object.keys(this.peers);

    if (this.opts.debug) console.debug("DEBUG: Gossiping to:", peersToSend);

    for (let peerId of peersToSend) {
      try {
        this.peers[peerId].send(JSON.stringify(message));
      } catch (error) {
        console.debug(
          `Error sending to peer. ${peerId} is no longer connected.`
        );
        delete this.peers[peerId];

        if (retries < 3) {
          if (this.opts.debug)
            console.debug(
              `DEBUG: Retrying message send (attempt ${retries + 1})`
            );
          await this.send(data, null, retries + 1);
          break;
        }
      }
    }
  }

  selectPeersToSend(data, targetPeerIds) {
    const peerKeys = Object.keys(this.peers);
    let filteredPeerIds = targetPeerIds
      ? peerKeys.filter(
          (peerId) => targetPeerIds.includes(peerId) && peerId !== this.peerId
        )
      : peerKeys.filter(
          (peerId) => peerId !== this.peerId && peerId !== data.gossiperId
        );

    if (!targetPeerIds && this.opts.fanoutRatio) {
      const fanoutCount = Math.ceil(
        filteredPeerIds.length * this.opts.fanoutRatio
      );
      filteredPeerIds = this.shuffleArray(filteredPeerIds).slice(
        0,
        fanoutCount
      );
    }

    if (filteredPeerIds.length < this.opts.minPeers) {
      const additionalPeersNeeded = this.opts.minPeers - filteredPeerIds.length;
      const availablePeers = peerKeys.filter(
        (peerId) => !filteredPeerIds.includes(peerId) && peerId !== this.peerId
      );
      // Shuffle to randomize selection and then take as many as needed
      const additionalPeers = this.shuffleArray(availablePeers).slice(
        0,
        additionalPeersNeeded
      );
      filteredPeerIds = filteredPeerIds.concat(additionalPeers);
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