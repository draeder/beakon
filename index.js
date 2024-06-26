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
    this.seen = new Set();
    this.last = "";
    this.simplePeerOpts = opts.simplePeerOpts;
    this.init();
    if (isBrowser) window.beakon = this;
  }

  async init() {
    this.peerId = this.opts.peerId || (await this.generateRandomSHA1Hash());
    console.log("This peer ID", this.peerId);

    this.setupListeners();
    this.announcePresence();
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
      message: async (message) => {
        // console.log(Object.keys(this.peers).length);
        // if (Object.keys(this.peers).length > 1) return;
        const { sender, data, type, target } = message.message;
        if (sender === this.peerId) return;
        if (target && target !== this.peerId) return;

        if (this.opts.debug === true)
          console.debug("DEBUG: Received message from pubnub:", message);
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
    let message = {
      channel: "peersChannel",
      message: {
        sender: this.peerId,
        type: "announce-presence",
      },
    };
    try {
      this.pubnub.publish(message);
    } catch {
      setTimeout(() => {
        this.pubnub.publish(message);
      }, 150);
    }
  }

  handleNewPeer(peerId) {
    if (!this.peers[peerId]) {
      this.createPeer(peerId, true);
    } else {
      let message = {
        channel: "peersChannel",
        message: {
          sender: this.peerId,
          type: "announce-connection",
          target: peerId,
        },
      };
      try {
        this.pubnub.publish(message);
      } catch {
        setTimeout(() => {
          this.pubnub.publish(message);
        }, 150);
      }
    }
  }

  handleSignal(peerId, signal) {
    if (!this.peers[peerId]) {
      this.createPeer(peerId, false);
    }
    if (this.peers[peerId]) this.peers[peerId].signal(signal);
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
    if (this.opts.debug === true) {
      console.debug(
        "DEBUG: Creating peer...",
        "peer count:",
        currentPeerCount,
        {
          initiator,
          peerId,
        }
      );
    }
    const peer = new SimplePeer({
      initiator,
      trickle: true,
      wrtc: this.opts.simplePeerOpts.wrtc,
    });

    peer.on("signal", async (signal) => {
      if (this.opts.debug)
        console.debug("DEBUG: Received new peer signal", signal);
      const message = {
        channel: "peersChannel",
        message: {
          sender: this.peerId,
          type: "signal",
          data: JSON.stringify(signal),
          target: peerId,
        },
      };

      try {
        this.pubnub.publish(message);
      } catch {
        setTimeout(() => {
          this.pubnub.publish(message);
        }, 150);
      }
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

    peer.on("data", (data) => {
      if (this.last === data) return;
      let parsedData;
      try {
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
        if (this.seenMessageIds.has(parsedData.gossipId)) return;
        this.addSeenMessage(parsedData);
        this.seenMessageIds.add(parsedData.messageId);
        // console.log(`Data from ${parsedData.senderId}:`, parsedData);

        this.send(parsedData, parsedData.to);
      } catch (error) {
        console.error(`Error parsing data from ${peerId}:`, error);
      }

      // switch (parsedData.type) {
      //   case "announce-presence":
      //     console.log("P2P", parsedData);
      //     return process.exit(1);
      //     if (this.opts.debug === true)
      //       console.debug("DEBUG: Received P2P announcement:", parsedData);
      //     this.handleNewPeer(parsedData.senderId);
      //     break;
      //   case "signal":
      //     console.log("P2P:", parsedData);
      //     return process.exit(1);
      //     if (this.opts.debug === true)
      //       console.debug("DEBUG: Received P2P signal:", parsedData);

      //     this.handleSignal(parsedData.senderId, parsedData);
      //     break;
      // }
      this.last = data;
    });

    peer.on("close", () => {
      if (this.opts.debug === true)
        console.debug(`Disconnected from peer: ${peerId}`);
      this.emit("peer", { id: peerId, state: "disconnected" });
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
    for (let msg in this.seenMessages) {
      if (message.gossipId !== msg.gossipId) this.seenMessages.push(message);
      if (this.seenMessages.length > this.opts.maxHistory)
        this.seenMessages.shift();
    }
  }

  async send(data, to, type = null, retries = 0) {
    if (this.last === data) return;
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
      type: type ? type : data.type,
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
