let SimplePeer, PubNub;

const isBrowser =
  typeof window !== "undefined" && typeof window.document !== "undefined";

if (isBrowser) {
  SimplePeer = (await import("https://jspm.dev/simple-peer")).default;
  PubNub = (await import("https://jspm.dev/pubnub")).default;
} else {
  SimplePeer = (await import("simple-peer")).default;
  PubNub = (await import("pubnub")).default;
}

class Beakon {
  constructor(opts) {
    const emitter = new EventEmitter();

    this.on = (event, listener) => emitter.on(event, listener);
    this.once = (event, listener) => emitter.once(event, listener);
    this.off = (event, listener) => emitter.off(event, listener);
    this.emit = (event, data) => emitter.emit(event, data);

    this.opts = opts;
    if (!isBrowser && !opts.simplePeerOpts.wrtc)
      return console.error(
        "Error: opts.simplePeerOpts.wrtc is required for node.js instances."
      );
    this.pubnub = new PubNub(opts.pubnubConfig);
    this.peers = new Set();
    this.seenGossipIds = new Set();
    this.seenMessageIds = new Set();
    this.seenMessages = [];
    this.last = "";
    this.simplePeerOpts = opts.simplePeerOpts;
    this.init();
    if (isBrowser) window.beakon = this;
  }

  async init() {
    this.lastGossipID = "";
    this.peerId = this.opts.peerId || (await this.generateRandomSHA1Hash());
    console.log("This peer ID", this.peerId);

    this.setupListeners();
    this.announcePresence();

    if (!isBrowser) {
      process.on("exit", (code) => {
        console.log(`About to exit with code: ${code}`);
        this.send({ type: "exit", content: "peer exit . . ." });
      });

      process.on("uncaughtException", async (error) => {
        console.error("Unhandled exception:", error);
        await this.send({ type: "exit", content: "peer exit . . ." });
        process.exit(1); // Exit with a failure code
      });

      process.on("unhandledRejection", async (reason, promise) => {
        console.error("Unhandled rejection at:", promise, "reason:", reason);
        process.exit(1); // It's a good practice to exit after handling the rejection
        await this.send({ type: "exit", content: "peer exit . . ." });
      });

      process.on("SIGINT", async () => {
        console.log("Received SIGINT. Perform cleanup.");
        await this.send({ type: "exit", content: "peer exit . . ." });
        process.exit(0);
      });

      process.on("SIGTERM", async () => {
        console.log("Received SIGTERM. Perform cleanup.");
        await this.send({ type: "exit", content: "peer exit . . ." });
        process.exit(0);
      });
    }
  }

  async generateRandomSHA1Hash() {
    const array = new Uint8Array(20);
    let hashBuffer;

    if (isBrowser) {
      window.crypto.getRandomValues(array);
      hashBuffer = await window.crypto.subtle.digest("SHA-1", array);
    } else {
      const dotenv = await import("dotenv");
      dotenv.config();

      const crypto = await import("crypto");
      crypto.randomFillSync(array);
      const hash = crypto.createHash("sha1");
      hash.update(array);
      // For Node.js, the hash.digest() returns a Buffer, so we directly use it
      return hash.digest("hex");
    }

    // This part is for browsers, as Node.js uses the return inside the else block
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
      console.debug("DEBUG: Creating peer...", {
        initiator,
        peerId,
      });
    const peer = new SimplePeer({
      initiator,
      trickle: true,
      wrtc: this.opts.simplePeerOpts.wrtc,
    });

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

      this.emit("peer", { id: peerId, state: "connected", connection: peer });

      if (this.seenMessages.length > 0)
        this.seenMessages.forEach((message) => {
          if (this.opts.debug === true)
            console.debug("DEBUG: Trying to send history.", message);
          setTimeout(() => this.send(message, message.to), 150);
        });
    });

    // let last;
    peer.on("data", (data) => {
      // if (last === data) return;
      let parsedData;
      try {
        // last = data;
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
        // console.log(`Data from ${parsedData.senderId}:`, parsedData);

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
      // if (peerCount <= 1) this.reinitialize();
    });

    peer.on("error", (error) => {
      if (error.reason === "Close called") return;
      const peerCount = Object.keys(this.peers).length;
      if (this.opts.debug === true)
        console.debug(`DEBUG: Error with peer ${peerId}:`, error);
      // if (peerCount <= 1) this.reinitialize();
    });

    this.peers[peerId] = peer;
  }

  addSeenMessage(message) {
    if (!this.seenMessages.includes(message)) this.seenMessages.push(message);
    if (this.seenMessages.length > this.opts.maxHistory)
      this.seenMessages.shift();
  }

  async send(data, to, type, retries = 0) {
    // stagger messages to avoid race conditions
    const randomDelay = Math.floor(Math.random() * 50);
    await delay(randomDelay);

    if (this.last === data) return;
    let gossipId = !data.gossipId
      ? await this.generateRandomSHA1Hash()
      : data.gossipId;
    let messageId = data.messageId
      ? data.messageId
      : await this.generateRandomSHA1Hash();

    let date = data.date ? data.date : new Date().getTime();

    if (this.lastGossipID === data.gossipId) return;
    this.lastGossipID = data.gossipId;

    let targetPeerIds = to;
    if (this.seenGossipIds.has(gossipId)) return; // && retries === 0) return;
    this.seenGossipIds.add(gossipId);

    let message = {
      messageId: messageId,
      senderId: data.senderId ? data.senderId : this.peerId,
      gossiperId: this.peerId,
      date: date,
      gossipId: gossipId,
      to: targetPeerIds,
      type: type,
      content: typeof data === "object" ? data.content : data,
    };

    if (!this.seenMessages.includes(message) && !isBrowser)
      this.emit("data", message);
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
        await this.send(data, targetPeerIds);
      }
    }
    this.last === data;
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

  // async reinitialize() {
  //   setTimeout(async () => {
  //     if (this.opts.debug) console.debug("Reinitializing beakon . . . ");
  //     await this.destroy();
  //     let opts = this.opts;
  //     if (isBrowser) window.beakon = null;
  //     new Beakon(opts);
  //   }, 5000);
  // }

  // async destroy() {
  //   await this.pubnub.unsubscribeAll();
  //   await Promise.all(Object.values(this.peers).map((peer) => peer.destroy()));
  // }
}

export default Beakon;

/* Utilities */

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
