import { initializeApp } from "https://www.gstatic.com/firebasejs/9.6.10/firebase-app.js";
import {
  getDatabase,
  ref,
  set,
  onChildAdded,
  push,
  child,
  get,
  remove,
  onDisconnect,
} from "https://www.gstatic.com/firebasejs/9.6.10/firebase-database.js";

import SimplePeer from "https://jspm.dev/simple-peer";

import firebaseConfig from "./auth.js";

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

const clientId = await generateRandomSHA1Hash();

const Beakon = function (opts) {
  const emitter = new EventEmitter();

  this.on = (event, listener) => emitter.on(event, listener);
  this.once = (event, listener) => emitter.once(event, listener);
  this.off = (event, listener) => emitter.off(event, listener);
  this.emit = (event, data) => emitter.emit(event, data);
  this.address = opts.peerId || clientId;

  const minPeers = opts.minPeers || 3;
  const maxPeers = opts.maxPeers / 2 || 10;
  const fanoutRatio = opts.fanoutRatio || 0.6;

  const peers = {};
  let activeConnections = 0;
  const receivedMessageIds = new Set();
  const messageHistory = (this.messageHistory = []);

  // beakon.get = (e) => {
  //   switch(e) {
  //     case "history":
  //       beakon.send()
  //   }

  // };

  let discoveryIntervalId;

  this.destroy = function () {
    if (discoveryIntervalId) {
      clearInterval(discoveryIntervalId);
      discoveryIntervalId = null;
    }
    // Additional cleanup actions here
  };

  discoveryIntervalId = setInterval(() => {
    if (activeConnections < 1) {
      this.destroy(); // Cleanup before "destroying"
      // Now, it's safe to create a new instance if necessary
      new Beakon(opts);
    }
  }, opts.discoveryInterval * 1000 || 30 * 1000);

  let beakon = (window.beakon = this);

  window.beakon.seen = new Set();
  window.beakon.peers = () => {
    return Object.keys(peers).filter((peerId) => peers[peerId].connected);
  };
  window.beakon.history = messageHistory;

  initializeApp(firebaseConfig);

  const db = getDatabase();

  async function registerClient() {
    const clientRef = ref(db, `clients/${clientId}`);
    await set(clientRef, { active: true });
    onDisconnect(clientRef)
      .remove()
      .then(() => {
        if (opts.debug)
          beakon.emit(
            "DEBUG",
            `On disconnect handler set up for client ${clientId}`
          );
      });
    await set(ref(db, `clients/${clientId}`), { active: true });
    listenForNotifications();
    discoverPeers();
  }

  function peerBuffer(n, z) {
    if (typeof n !== "number" || typeof z !== "number" || n > z) {
      if (opts.debug) {
        console.error("Invalid input: n must be less than or equal to z.");
        return null;
      }
    }

    const randomNumber = Math.floor(Math.random() * (z - n + 1)) + n;
    return randomNumber;
  }

  function listenForNotifications() {
    const notificationsRef = ref(db, "notifications");
    onChildAdded(notificationsRef, (snapshot) => {
      if (
        Object.keys(peers).length >
        peerBuffer(minPeers, maxPeers) + peerBuffer(minPeers, maxPeers)
      ) {
        updatePeerCount();
        return;
      }
      const { from, to, data } = snapshot.val();
      if (to === clientId) {
        if (opts.debug) beakon.emit("DEBUG", `Received signal from ${from}`);
        if (!peers[from]) {
          peers[from] = {
            peer: new SimplePeer({ initiator: false, trickle: false }),
            notificationIds: [],
          };
          setupPeer(from, snapshot.key);
        } else {
          peers[from].notificationIds.push(snapshot.key);
        }
        try {
          peers[from].peer.signal(data);
        } catch (e) {}
      }
    });
  }

  async function discoverPeers() {
    const snapshot = await get(child(ref(db), "clients"));
    snapshot.forEach((childSnapshot) => {
      const peerId = childSnapshot.key;
      if (peerId !== clientId && Object.keys(peers).length < maxPeers) {
        if (opts.debug) beakon.emit("DEBUG", `Discovered peer: ${peerId}`);
        peers[peerId] = {
          peer: new SimplePeer({ initiator: true, trickle: false }),
          notificationIds: [],
        };
        setupPeer(peerId);
      }
    });
  }

  function setupPeer(peerId, initialNotificationId = null) {
    const peer = peers[peerId].peer;
    if (initialNotificationId)
      peers[peerId].notificationIds.push(initialNotificationId);
    peer.on("signal", async (data) => {
      if (peer.connectionState === "stable") {
        if (opts.debug) {
          beakon.emit(
            "DEBUG",
            `Connection with peer ${peerId} is already stable. No action taken.`
          );
        }
        return;
      }

      const pushRef = await push(ref(db, "notifications"), {
        from: clientId,
        to: peerId,
        data,
      });
      if (peers[peerId] && !peers[peerId].notificationIds)
        peers[peerId].notificationIds = [];
      peers[peerId].notificationIds.push(pushRef.key);

      setTimeout(async () => {
        try {
          await remove(ref(db, `notifications/${pushRef.key}`));
          if (opts.debug) {
            beakon.emit(
              "DEBUG",
              `Successfully cleaned up notification ${pushRef.key} for peer ${peerId}.`
            );
          }

          if (peers[peerId] && peers[peerId].notificationIds) {
            const index = peers[peerId].notificationIds.indexOf(pushRef.key);
            if (index !== -1) {
              peers[peerId].notificationIds.splice(index, 1);
            }
          }
        } catch (error) {
          if (opts.debug) {
            beakon.emit(
              "DEBUG",
              `Error cleaning notification ${pushRef.key} for ${peerId}: ${error}`
            );
          }
        }
      }, 5000);
    });

    peer.on("connect", async () => {
      console.debug(`Connected to ${peerId}`);
      activeConnections++;
      updatePeerCount();
      peers[peerId].connected = true;
      const notificationsToRemove = peers[peerId].notificationIds;
      await Promise.all(
        notificationsToRemove.map((notificationId) =>
          remove(ref(db, `notifications/${notificationId}`))
        )
      );
      beakon.emit("connect", peerId);
      send(peerId, "connect");
      peers[peerId].notificationIds = [];
      beakon.emit(
        "DEBUG",
        "Sharing message history with " +
          peerId +
          JSON.stringify(messageHistory)
      );
      if (beakon.seen.has(peerId)) {
        messageHistory.forEach((message) => {
          if (message.type === "data") {
            // peers[peerId].peer.send(JSON.stringify(message));
            broadcastMessage(message);
          }
        });
        if (opts.debug)
          beakon.emit("DEBUG", `Shared message history with ${peerId}`);
      }
    });
    peer.on("data", (data) => recvMessage(data, peerId));
    peer.on("error", async (error) => {
      if (opts.debug)
        beakon.emit("DEBUG", `Error with peer ${peerId}: ${error}`);
      let notificationsToRemove;
      if (peers[peerId]) notificationsToRemove = peers[peerId].notificationIds;
      await Promise.all(
        notificationsToRemove.map((notificationId) =>
          remove(ref(db, `notifications/${notificationId}`))
        )
      );
    });
    peer.on("close", async () => {
      console.debug(`Disconnected from ${peerId}`);
      if (activeConnections > 0) activeConnections--;
      if (!peers[peerId]) return;
      const notificationsToRemove = peers[peerId].notificationIds;
      await Promise.all(
        notificationsToRemove.map((notificationId) =>
          remove(ref(db, `notifications/${notificationId}`))
        )
      );
      delete peers[peerId];
      send(peerId, "disconnect");
      updatePeerCount();
    });
  }

  async function updatePeerCount() {
    const peerCountRef = ref(db, `clients/${clientId}/peerCount`);
    await set(peerCountRef, Object.keys(peers).length);
  }

  function* rebroadcastMessage(message, n, delay) {
    for (let i = 0; i < n; i++) {
      yield new Promise((resolve) =>
        setTimeout(() => {
          broadcastMessage(message);
          resolve();
        }, delay)
      );
    }
  }

  function runGenerator(genFunc) {
    const generator = genFunc();

    function handleNext(value) {
      const next = generator.next(value);
      if (!next.done) {
        next.value.then(handleNext);
      }
    }

    handleNext();
  }

  function broadcastMessage(message) {
    const connectedPeers = Object.keys(peers).filter(
      (peerId) => peers[peerId].connected
    );

    if (connectedPeers.length <= minPeers) {
      connectedPeers.forEach((peerId) =>
        peers[peerId].peer.send(JSON.stringify(message))
      );
    } else {
      if (Object.keys(peers).length <= minPeers) fanoutRatio = 1;
      const selectedPeers = selectRandomPeers(
        connectedPeers,
        Math.ceil(connectedPeers.length * fanoutRatio)
      );
      selectedPeers.forEach((peerId) =>
        peers[peerId].peer.send(JSON.stringify(message))
      );
    }

    if (message.type === "data" && !receivedMessageIds.has(message.gossipId)) {
      runGenerator(() =>
        rebroadcastMessage(message, opts.gossipRT || 5, opts.gossipRTT || 150)
      );
    }
  }

  function selectRandomPeers(peersArray, count) {
    for (let i = peersArray.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [peersArray[i], peersArray[j]] = [peersArray[j], peersArray[i]];
    }
    return peersArray.slice(0, count);
  }

  const send = (beakon.send = async (content, type) => {
    const message = {
      gossipId: await generateRandomSHA1Hash(),
      date: new Date(),
      senderId: clientId,
      type: type || "data",
      content,
    };

    message.messageId = await sha1(JSON.stringify(message));

    if (opts.debug)
      beakon.emit("DEBUG", `Sending message: ${JSON.stringify(message)}`);
    receivedMessageIds.add(message.gossipId);
    if (message.type === "data") {
      messageHistoryManager(message);
    }
    broadcastMessage(message);
    let intervalId;
    let sendAttempt = 1;
    setTimeout(() => {
      intervalId = setInterval(() => {
        if (sendAttempt === 3) clearInterval(intervalId);
        sendAttempt++;
      }, 150);
    }, 1500);
  });

  // if (Object.keys(peers)) {
  //   setInterval(() => {
  //     send(new Date(), "heartbeat");
  //   }, 30 * 1000);
  // }

  function messageHistoryManager(message) {
    // Add the new message to the history
    beakon.messageHistory.push(message);

    // Sort the messageHistory array by the date property
    beakon.messageHistory.sort((a, b) => new Date(a.date) - new Date(b.date));

    // Check if the messageHistory array size has reached its maximum allowed size
    while (beakon.messageHistory.length > opts.messageHistoryMax) {
      // Remove the oldest message (now at the beginning after sorting)
      beakon.messageHistory.shift();
    }
  }

  let lastPeerStateMessage = "";
  function recvMessage(data, fromPeerId) {
    try {
      const message = JSON.parse(data);

      if (opts.debug) beakon.emit("DEBUG", message);

      if (clientId !== message.senderId) beakon.seen.add(message.senderId);

      // let last;
      // if (message.type === "heartbeat") {
      //   if (message === last) return;
      //   console.log(message.senderId, clientId);
      //   if (message.senderId === clientId)
      //     beakon.emit("DEBUG", "reached self through the partial mesh!");
      //   receivedMessageIds.add(message.gossipId);
      //   // broadcastMessage(message);
      //   send(message);
      //   last = message;
      //   return;
      // }

      if (!receivedMessageIds.has(message.gossipId)) {
        if (message.type === "data") {
          beakon.emit("data", message);
          messageHistoryManager(message);
        }

        if (message.type === "connect") {
          if (message.content === clientId)
            return beakon.emit("DEBUG", "Reached self indirectly.");
          // beakon.emit("connect", message.content);
        }

        if (message.type === "disconnect") {
          if (
            lastPeerStateMessage === message.content &&
            message.content !== clientId
          )
            return;
          if (beakon.seen.has(message.content)) {
            beakon.seen.delete(message.content);
            beakon.emit("disconnect", message.content);
          }
          lastPeerStateMessage = message.content;
        }
        receivedMessageIds.add(message.gossipId);

        broadcastMessage(message);
      }
    } catch (error) {
      if (opts.debug)
        console.debug(`Error processing data from ${fromPeerId}:`, error);
    }
  }

  registerClient();
};

async function generateRandomSHA1Hash() {
  const randomValues = window.crypto.getRandomValues(new Uint8Array(20));
  const hashBuffer = await crypto.subtle.digest("SHA-1", randomValues);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hashHex;
}

async function sha1(objString) {
  // Convert the string to an ArrayBuffer
  const buffer = new TextEncoder().encode(objString);

  // Use the Web Crypto API to hash the ArrayBuffer
  const hashBuffer = await crypto.subtle.digest("SHA-1", buffer);

  // Convert the ArrayBuffer to a hex string
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  return hashHex;
}

export default Beakon;
