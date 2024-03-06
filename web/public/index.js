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

import firebaseConfig from "./auth.js";

initializeApp(firebaseConfig);
const db = getDatabase();

const clientId = await generateRandomSHA1Hash();
const peers = {};
let activeConnections = 0;
const maxPeers = 6;
const fanoutRatio = 0.5;
const receivedMessageIds = new Set();
const messageHistory = [];
let recv = {};

async function registerClient() {
  const clientRef = ref(db, `clients/${clientId}`);
  await set(clientRef, { active: true });
  onDisconnect(clientRef)
    .remove()
    .then(() =>
      console.debug(`On disconnect handler set up for client ${clientId}`)
    );
  await set(ref(db, `clients/${clientId}`), { active: true });
  listenForNotifications();
  discoverPeers();
}

function listenForNotifications() {
  const notificationsRef = ref(db, "notifications");
  onChildAdded(notificationsRef, (snapshot) => {
    if (Object.keys(peers).length > maxPeers) {
      updatePeerCount();
      return;
    }
    const { from, to, data } = snapshot.val();
    if (to === clientId) {
      console.debug(`Received signal from ${from}`);
      if (!peers[from]) {
        peers[from] = {
          peer: new SimplePeer({ initiator: false, trickle: false }),
          notificationIds: [],
        };
        setupPeer(from, snapshot.key);
      } else {
        peers[from].notificationIds.push(snapshot.key);
      }
      peers[from].peer.signal(data);
    }
  });
}

async function discoverPeers() {
  const snapshot = await get(child(ref(db), "clients"));
  snapshot.forEach((childSnapshot) => {
    const peerId = childSnapshot.key;
    if (peerId !== clientId && Object.keys(peers).length < maxPeers) {
      console.debug("Discovered peer:", peerId);
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
  peer.on("signal", (data) => {
    push(ref(db, "notifications"), { from: clientId, to: peerId, data }).then(
      (pushRef) => peers[peerId].notificationIds.push(pushRef.key)
    );
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
    shareMessageHistoryWithPeer(peerId);
    peers[peerId].notificationIds = [];
  });
  peer.on("data", (data) => recvMessage(data, peerId));
  peer.on("error", async (error) => {
    console.debug(`Error with peer ${peerId}:`, error);
    const notificationsToRemove = peers[peerId].notificationIds;
    await Promise.all(
      notificationsToRemove.map((notificationId) =>
        remove(ref(db, `notifications/${notificationId}`))
      )
    );
  });
  peer.on("close", async () => {
    console.debug(`Disconnected from ${peerId}`);
    if (activeConnections > 0) activeConnections--;
    const notificationsToRemove = peers[peerId].notificationIds;
    await Promise.all(
      notificationsToRemove.map((notificationId) =>
        remove(ref(db, `notifications/${notificationId}`))
      )
    );
    delete peers[peerId];
    updatePeerCount();
  });
}

async function updatePeerCount() {
  const peerCountRef = ref(db, `clients/${clientId}/peerCount`);
  await set(peerCountRef, Object.keys(peers).length);
}

function broadcastMessage(message) {
  const connectedPeers = Object.keys(peers).filter(
    (peerId) => peers[peerId].connected
  );
  const selectedPeers = selectRandomPeers(
    connectedPeers,
    Math.ceil(connectedPeers.length * fanoutRatio)
  );
  selectedPeers.forEach((peerId) =>
    peers[peerId].peer.send(JSON.stringify(message))
  );
}

function selectRandomPeers(peersArray, count) {
  for (let i = peersArray.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [peersArray[i], peersArray[j]] = [peersArray[j], peersArray[i]];
  }
  return peersArray.slice(0, count);
}

const send = (window.send = (content) => {
  const message = {
    gossipId: Math.random().toString(36).substring(2, 15),
    senderId: clientId,
    content,
  };
  console.debug(`Sending message: ${content}`);
  receivedMessageIds.add(message.gossipId);
  messageHistory.push(message);
  broadcastMessage(message);
});

function shareMessageHistoryWithPeer(peerId) {
  const peer = peers[peerId];
  if (peer && peer.connected) {
    messageHistory.forEach((message) =>
      peer.peer.send(JSON.stringify(message))
    );
    console.debug(`Shared message history with ${peerId}`);
  }
}

window.count = () => {
  return Object.keys(peers).filter((peerId) => peers[peerId].connected);
};

function recvMessage(data, fromPeerId) {
  try {
    const message = JSON.parse(data);
    if (!receivedMessageIds.has(message.gossipId)) {
      console.log(`Message from ${fromPeerId}: ${message.content}`);
      receivedMessageIds.add(message.gossipId);
      messageHistory.push(message);
      broadcastMessage(message);
    }
  } catch (error) {
    console.error(`Error processing data from ${fromPeerId}:`, error);
  }
}

window.peers = peers;

window.messages = messageHistory;

async function generateRandomSHA1Hash() {
  const randomValues = window.crypto.getRandomValues(new Uint8Array(20));
  const hashBuffer = await crypto.subtle.digest("SHA-1", randomValues);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hashHex;
}

registerClient();

export default { send, recv, count, messages };
