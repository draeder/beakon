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
    this.peers = {};
    this.peerList = [];
    this.currentRelayIndex = 0;
    this.seenSignals = new Set(); // Track seen signals to deduplicate
    this.seenGossipIds = new Set();
    this.seenMessageIds = new Set();
    this.seenMessages = [];
    this.peerLastContact = {}; // Track the last contact time with each peer
    this.simplePeerOpts = opts.simplePeerOpts;
    this.init();
    if (isBrowser) window.beakon = this;
  }

  async init() {
    this.peerId = this.opts.peerId || (await this.generateRandomSHA1Hash());
    console.debug("This peer ID", this.peerId);

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
      return hash.digest("hex");
    }

    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  connections() {
    return Object.keys(this.peers);
  }

  setupListeners() {
    this.pubnub.addListener({
      message: async (message) => {
        const { sender, data, type, target, signalId } = message.message;
        if (sender === this.peerId) return;
        if (target && target !== this.peerId) return;

        if (this.opts.debug)
          console.debug("DEBUG: Received message from PubNub:", message);

        const isSelectedRelay = this.isCurrentRelayPeer();
        if (this.opts.debug)
          console.debug(
            `Peer ${this.peerId} is ${
              isSelectedRelay ? "" : "not "
            }the selected relay peer.`
          );

        switch (type) {
          case "announce-presence":
            this.handleNewPeer(sender);
            break;
          case "signal":
            if (!this.seenSignals.has(signalId)) {
              this.seenSignals.add(signalId);
              if (isSelectedRelay) {
                this.relaySignalToPeers(sender, data, signalId);
              }
              this.handleSignal(sender, JSON.parse(data));
            }
            break;
          case "relay-signal":
            if (!this.seenSignals.has(signalId)) {
              this.seenSignals.add(signalId);
              this.handleSignal(sender, JSON.parse(data));
            }
            break;
        }
      },
    });
    this.pubnub.subscribe({ channels: ["peersChannel"] });
  }

  handleNewPeer(peerId) {
    if (!this.peers[peerId]) {
      this.createPeer(peerId, true);
      this.peerList.push(peerId);
      this.updateRelayPeer();
      this.sendMessageHistory(peerId); // Send message history to new peer
      this.requestMessageHistory(peerId); // Request message history from new peer
    }
  }

  handleSignal(peerId, signal) {
    if (!this.peers[peerId]) {
      this.createPeer(peerId, false);
    }
    const peer = this.peers[peerId];
    if (peer && !peer.destroyed) {
      try {
        peer.signal(signal);
      } catch (error) {
        console.debug(`Error signaling peer ${peerId}:`, error);
      }
    } else {
      console.debug(`Peer ${peerId} is already destroyed.`);
      delete this.peers[peerId];
    }
  }

  announcePresence() {
    const message = {
      channel: "peersChannel",
      message: {
        sender: this.peerId,
        type: "announce-presence",
      },
    };
    try {
      this.pubnub.publish(message); // Send only once
    } catch (error) {
      console.error("Failed to announce presence:", error);
    }
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
      const signalId = await this.generateRandomSHA1Hash();
      const message = {
        channel: "peersChannel",
        message: {
          sender: this.peerId,
          type: this.isCurrentRelayPeer() ? "relay-signal" : "signal",
          data: JSON.stringify(signal),
          target: peerId,
          signalId,
        },
      };

      // Ensure the signal is only sent if the peer is still valid
      if (this.peers[peerId] && !this.peers[peerId].destroyed) {
        try {
          this.pubnub.publish(message).catch(() => {
            setTimeout(() => {
              if (this.peers[peerId] && !this.peers[peerId].destroyed) {
                this.pubnub.publish(message);
              }
            }, 150);
          });
        } catch (error) {
          console.debug(`Error publishing signal for peer ${peerId}:`, error);
        }
      }
    });

    peer.on("connect", () => {
      if (this.opts.debug) console.debug(`DEBUG: Connected to peer: ${peerId}`);

      this.emit("peer", { id: peerId, state: "connected", connection: peer });

      if (this.seenMessages.length > 0)
        this.seenMessages.forEach((message) => {
          if (this.opts.debug === true)
            console.debug("DEBUG: Trying to send history.", message);
          setTimeout(
            () => this.send(message, message.to, message.type, 0, 1, true),
            150
          );
        });

      // Update last contact time
      this.peerLastContact[peerId] = Date.now();
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

        // Only gossip broadcast messages
        if (!parsedData.to) {
          this.send(parsedData, parsedData.to, parsedData.type, 0, 1, true);
        }

        // Update last contact time
        this.peerLastContact[parsedData.senderId] = Date.now();

        // Handle message history synchronization
        if (parsedData.type !== "message-history") {
          this.handleMessageHistorySynchronization(parsedData.senderId);
        }
      } catch (error) {
        console.error(`Error parsing data from ${peerId}:`, error);
      }
      this.last = data;
    });

    peer.on("close", () => {
      if (this.opts.debug === true)
        console.debug(`Disconnected from peer: ${peerId}`);
      this.emit("peer", { id: peerId, state: "disconnected" });
      delete this.peers[peerId];
      this.peerList = this.peerList.filter((id) => id !== peerId);
      const peerCount = Object.keys(this.peers).length;
      if (this.opts.debug === true)
        console.debug("DEBUG: Peers in partial mesh:", peerCount);
      this.updateRelayPeer(); // Re-select relay peer on disconnection
    });

    peer.on("error", (error) => {
      console.debug(`DEBUG: Error with peer ${peerId}:`, error);
      // Avoid destroying the peer unless absolutely necessary
      if (error.code === "ERR_PEER_DESTROYED") return;
    });

    this.peers[peerId] = peer;
  }

  addSeenMessage(message) {
    if (message && !this.seenMessageIds.has(message.messageId)) {
      this.seenMessages.push(message);
      this.seenMessageIds.add(message.messageId);
      if (this.seenMessages.length > this.opts.maxHistory)
        this.seenMessages.shift();
    }
  }

  async send(
    data,
    to,
    type = null,
    retries = 0,
    backoff = 1,
    isHistoryMessage = false
  ) {
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

    if (!message.content) return;

    if (!this.seenMessages.includes(message)) this.emit("data", message);
    this.addSeenMessage(message);

    let peersToSend;
    if (Object.keys(this.peers).length <= 5) {
      peersToSend = Object.keys(this.peers);
    } else {
      peersToSend = this.selectPeersToSend(data, targetPeerIds);
      if (peersToSend.length < this.minPeers)
        peersToSend = Object.keys(this.peers);
    }

    if (this.opts.debug) console.debug("DEBUG: Sending to:", peersToSend);

    let success = false;

    for (let peerId of peersToSend) {
      const peer = this.peers[peerId];
      if (peer && !peer.destroyed && peer.connected) {
        try {
          peer.send(JSON.stringify(message));
          success = true;
        } catch (error) {
          console.debug(`Error sending to peer ${peerId}:`, error);
        }
      } else {
        if (this.opts.debug)
          console.debug(`Peer ${peerId} is already destroyed or not ready.`);
        delete this.peers[peerId];
      }
    }

    if (!success && retries < this.opts.maxRetries) {
      setTimeout(() => {
        const newPeersToSend = this.selectPeersToSend(data, targetPeerIds); // Select new peers
        this.send(
          data,
          newPeersToSend,
          type,
          retries + 1,
          backoff * 2,
          isHistoryMessage
        );
      }, this.opts.retryInterval * backoff); // Increase retry interval to reduce frequency
    }

    this.last = data;

    // Resend each message in message history after sending a new message, but only if this is not a history message
    if (!isHistoryMessage && !message.to) {
      for (let oldMessage of this.seenMessages) {
        const resendTargetPeerIds = this.selectPeersToSend(
          oldMessage,
          oldMessage.to
        );
        if (this.opts.debug)
          console.debug(
            "DEBUG: Resending message history to:",
            resendTargetPeerIds
          );
        for (let peerId of resendTargetPeerIds) {
          const peer = this.peers[peerId];
          if (peer && !peer.destroyed && peer.connected) {
            try {
              peer.send(JSON.stringify(oldMessage));
            } catch (error) {
              console.debug(
                `Error resending message history to peer ${peerId}:`,
                error
              );
            }
          }
        }
      }
    }
  }

  selectPeersToSend(data, targetPeerIds) {
    const peerKeys = Object.keys(this.peers);

    const senderId = data && data.senderId ? data.senderId : null;
    const gossiperId = data && data.gossiperId ? data.gossiperId : null;

    let filteredPeerIds = targetPeerIds
      ? peerKeys.filter(
          (peerId) =>
            targetPeerIds.includes(peerId) &&
            peerId !== this.peerId &&
            peerId !== senderId
        )
      : peerKeys.filter(
          (peerId) =>
            peerId !== this.peerId &&
            peerId !== gossiperId &&
            peerId !== senderId
        );

    filteredPeerIds.sort(
      (a, b) => (this.peerLastContact[a] || 0) - (this.peerLastContact[b] || 0)
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

  isCurrentRelayPeer() {
    return this.peerId === this.peerList[this.currentRelayIndex];
  }

  updateRelayPeer() {
    if (this.peerList.length > 0) {
      this.currentRelayIndex =
        (this.currentRelayIndex + 1) % this.peerList.length;
      if (this.opts.debug)
        console.debug(
          "Updated relay peer:",
          this.peerList[this.currentRelayIndex]
        );
    }
  }

  relaySignalToPeers(sender, signal, signalId) {
    for (let peerId of Object.keys(this.peers)) {
      if (peerId !== sender) {
        const peer = this.peers[peerId];
        if (peer && !peer.destroyed && peer.connected) {
          try {
            peer.send(
              JSON.stringify({
                type: "relay-signal",
                target: peerId,
                data: signal,
                signalId,
              })
            );
          } catch (error) {
            console.debug(`Error relaying signal to peer ${peerId}:`, error);
          }
        } else {
          console.debug(`Peer ${peerId} is already destroyed or not ready.`);
          delete this.peers[peerId];
        }
      }
    }
  }

  shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.ceil(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }

  // New methods for message history synchronization
  async sendMessageHistory(targetPeerId) {
    const peer = this.peers[targetPeerId];
    if (peer && !peer.destroyed && peer.connected) {
      try {
        const messageHistory = this.seenMessages;
        peer.send(
          JSON.stringify({
            type: "message-history",
            data: messageHistory,
            sender: this.peerId,
          })
        );
      } catch (error) {
        console.debug(
          `Error sending message history to peer ${targetPeerId}:`,
          error
        );
      }
    }
  }

  async requestMessageHistory(targetPeerId) {
    const peer = this.peers[targetPeerId];
    if (peer && !peer.destroyed && peer.connected) {
      try {
        peer.send(
          JSON.stringify({
            type: "request-message-history",
            sender: this.peerId,
          })
        );
      } catch (error) {
        console.debug(
          `Error requesting message history from peer ${targetPeerId}:`,
          error
        );
      }
    }
  }

  handleMessageHistorySynchronization(senderId) {
    const peer = this.peers[senderId];
    if (peer && !peer.destroyed && peer.connected) {
      try {
        const messageHistory = this.seenMessages;
        peer.send(
          JSON.stringify({
            type: "message-history",
            data: messageHistory,
            sender: this.peerId,
          })
        );
      } catch (error) {
        console.debug(
          `Error sending message history to peer ${senderId}:`,
          error
        );
      }
    }
  }

  handleMessageHistory(senderId, receivedHistory) {
    const missingMessages = this.getMissingMessages(receivedHistory);
    if (missingMessages.length > 0) {
      this.requestMissingMessages(senderId, missingMessages);
    }
  }

  getMissingMessages(receivedHistory) {
    const localMessageIds = new Set(
      this.seenMessages.map((msg) => msg.messageId)
    );
    return receivedHistory.filter((msg) => !localMessageIds.has(msg.messageId));
  }

  async requestMissingMessages(senderId, missingMessages) {
    const peer = this.peers[senderId];
    if (peer && !peer.destroyed && peer.connected) {
      try {
        peer.send(
          JSON.stringify({
            type: "request-messages",
            data: missingMessages,
            sender: this.peerId,
          })
        );
      } catch (error) {
        console.debug(
          `Error requesting missing messages from peer ${senderId}:`,
          error
        );
      }
    }
  }

  handleRequestMessages(senderId, requestedMessages) {
    const peer = this.peers[senderId];
    if (peer && !peer.destroyed && peer.connected) {
      try {
        const messagesToSend = this.seenMessages.filter((msg) =>
          requestedMessages.some((reqMsg) => reqMsg.messageId === msg.messageId)
        );
        peer.send(
          JSON.stringify({
            type: "response-messages",
            data: messagesToSend,
            sender: this.peerId,
          })
        );
      } catch (error) {
        console.debug(
          `Error sending requested messages to peer ${senderId}:`,
          error
        );
      }
    }
  }

  handleResponseMessages(receivedMessages) {
    receivedMessages.forEach((message) => {
      if (message && !this.seenMessageIds.has(message.messageId)) {
        this.seenMessages.push(message);
        this.seenMessageIds.add(message.messageId);
        this.emit("data", message);
      }
    });
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
