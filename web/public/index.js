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

const clientId = await generateRandomSHA1Hash(); // Math.random().toString(36).substring(2, 15);
const peers = {};
let activeConnections = 0;
const maxPeers = 6;
const fanoutRatio = 0.5;
const receivedMessageIds = new Set();
const messageHistory = [];
const outOfOrderMessageBuffer = [];
let recv = {};

async function registerClient() {
  console.debug("Registering client with ID:", clientId);
  const clientRef = ref(db, `clients/${clientId}`);
  // Set client's presence
  await set(clientRef, { active: true });

  // Setup onDisconnect handler
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
    0;
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
    if (peerId && peerId !== clientId && Object.keys(peers).length < maxPeers) {
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
  if (initialNotificationId) {
    peers[peerId].notificationIds.push(initialNotificationId);
  }
  peer.on("signal", (data) => {
    try {
      push(ref(db, "notifications"), { from: clientId, to: peerId, data })
        .then((pushRef) => {
          peers[peerId].notificationIds.push(pushRef.key);
        })
        .catch((error) =>
          console.error(`Error during signaling with ${peerId}:`, error)
        ); // Handle promise rejection
    } catch (error) {
      console.error(`Error during signaling setup with ${peerId}:`, error);
    }
  });
  peer.on("connect", async () => {
    console.debug(`Connected to ${peerId}`);
    activeConnections++;
    updatePeerCount();
    peers[peerId].connected = true;

    // Assuming all notification entries are correctly stored in `peers[peerId].notificationIds`
    // Iterate and remove each notification entry from Firebase
    const notificationsToRemove = peers[peerId].notificationIds;
    await Promise.all(
      notificationsToRemove.map((notificationId) =>
        remove(ref(db, `notifications/${notificationId}`))
      )
    );

    shareMessageHistoryWithPeer(peerId);

    // After cleanup, reset the list of notification IDs
    peers[peerId].notificationIds = [];
  });
  recv = peer.on("data", (data) => {
    try {
      const message = JSON.parse(data);
      if (
        !receivedMessageIds.has(message.gossipId) &&
        message.senderId !== clientId
      ) {
        console.log(`Message from ${message.senderId}: ${message.content}`);
        receivedMessageIds.add(message.gossipId);
        broadcastMessage(message);
      }
    } catch (error) {
      console.error(`Error processing data from ${peerId}:`, error);
    }
  });
  peer.on("error", (error) => {
    console.debug(`Error with peer ${peerId}:`, error);
  });
  peer.on("close", () => {
    console.debug(`Disconnected from ${peerId}`);
    if (activeConnections > 0) activeConnections--;
    delete peers[peerId];
    updatePeerCount();
  });
}

async function updatePeerCount() {
  const peerCountRef = ref(db, `clients/${clientId}/peerCount`);
  const currentPeerCount = Object.keys(peers).length; // Assuming this is how you're tracking connected peers
  await set(peerCountRef, currentPeerCount);
}

async function getUserMediaStream() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: true,
      audio: true,
    });
    return stream;
  } catch (error) {
    console.error("Error accessing media devices.", error);
    throw error; // Rethrow or handle as needed
  }
}

function broadcastMessage(message) {
  // Adding a timestamp to the message
  const timestamp = Date.now();
  const messageWithTimestamp = { ...message, timestamp };

  const connectedPeers = Object.keys(peers).filter(
    (peerId) => peers[peerId].connected
  );
  const fanoutCount = Math.ceil(connectedPeers.length * fanoutRatio);
  const selectedPeers = selectRandomPeers(connectedPeers, fanoutCount);

  selectedPeers.forEach((peerId) => {
    peers[peerId].peer.send(JSON.stringify(messageWithTimestamp));
  });
}

function selectRandomPeers(peersArray, count) {
  // Shuffle array using Durstenfeld shuffle algorithm
  for (let i = peersArray.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [peersArray[i], peersArray[j]] = [peersArray[j], peersArray[i]];
  }
  // Select the first 'count' elements
  return peersArray.slice(0, count);
}

const send = (window.send = (content) => {
  const message = {
    gossipId: Math.random().toString(36).substring(2, 15),
    senderId: clientId,
    content,
    timestamp: Date.now(), // Add current timestamp to the message
  };
  console.debug(`Sending message: ${content}`);
  receivedMessageIds.add(message.gossipId);
  messageHistory.push(message); // Add message to history
  broadcastMessage(message);
});
function shareMessageHistoryWithPeer(peerId) {
  // Assuming messageHistory contains all messages received, not just those sent by this peer
  const peer = peers[peerId];
  if (peer && peer.connected) {
    const sortedHistory = [...messageHistory].sort(
      (a, b) => a.timestamp - b.timestamp
    );
    sortedHistory.forEach((message) => {
      // Immediately send each message in order
      peer.peer.send(JSON.stringify(message));
    });
    console.debug(`Shared sorted message history with ${peerId}`);
  }
}

window.peers = () => {
  console.debug(`Active connections: ${activeConnections}`);
  Object.keys(peers).forEach((peerId) => {
    if (peers[peerId].connected) {
      console.debug(`Connected to ${peerId}`);
    }
  });
};

async function generateRandomSHA1Hash() {
  // Generate a random array of bytes
  const randomValues = window.crypto.getRandomValues(new Uint8Array(20)); // SHA-1 hashes are 160 bits (20 bytes)
  // Hash the random bytes using SHA-1
  const hashBuffer = await crypto.subtle.digest("SHA-1", randomValues);
  // Convert the buffer to a hex string
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return hashHex;
}

registerClient();

export default { send, recv };
