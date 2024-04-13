import Beakon from "./index.js";
import auth from "./pubnub/auth.js";
import SimplePeer from "simple-peer";
import wrtc from "wrtc";

const opts = {
  pubnubConfig: auth,
  simplePeerOpts: { wrtc: wrtc },
  minPeers: 2,
  softCap: 6,
  maxPeers: 9,
  minFanout: 0.33,
  maxFanout: 0.66,
  maxHistory: 10,
  debug: true, // Enable debug for detailed logs
};

const beakon = new Beakon(opts);
const simplePeers = {}; // Dictionary to store SimplePeer instances
const peerIDs = new Set(); // Store Beakon peer IDs to ensure uniqueness

beakon.on("peer", (info) => {
  console.debug("Beakon Peer event:", info.id, info.state);
  peerIDs.add(info.id); // Add Beakon peer ID to the set
  ensureSimplePeerInstance(info);
});

function ensureSimplePeerInstance(info) {
  if (!simplePeers[info.id]) {
    // Generate a unique ID for SimplePeer that is not the same as any Beakon peer ID
    let uniqueSimplePeerId = generateUniqueID();
    const simplePeer = new SimplePeer({
      id: uniqueSimplePeerId, // Use a unique ID for SimplePeer
      initiator: true,
      trickle: true,
      wrtc: wrtc,
    });

    simplePeer.on("signal", (data) => {
      console.log(
        `Sending signal to ${uniqueSimplePeerId} (Beakon ID: ${info.id})`,
        data
      );
      beakon.send({
        type: "signal",
        content: JSON.stringify(data),
        to: info.id,
      });
    });

    simplePeer.on("connect", () => {
      console.log(
        `SimplePeer connection established with ${uniqueSimplePeerId} (Beakon ID: ${info.id})`
      );
    });

    simplePeer.on("data", (data) => {
      console.log(
        `Message from ${uniqueSimplePeerId} (Beakon ID: ${info.id}): ${data}`
      );
    });

    simplePeer.on("error", (error) => {
      console.error(
        `Error in SimplePeer connection with ${uniqueSimplePeerId} (Beakon ID: ${info.id}):`,
        error
      );
    });

    simplePeers[info.id] = simplePeer;
  }
  // Process any pending signals if there are any
  if (info.signal && simplePeers[info.id]) {
    console.log(
      `Processing received signal for ${info.id} (SimplePeer ID: ${
        simplePeers[info.id].id
      })`,
      info.signal
    );
    simplePeers[info.id].signal(JSON.parse(info.signal));
  }
}

function generateUniqueID() {
  let newId;
  do {
    newId = Math.random().toString(36).substring(2, 15);
  } while (peerIDs.has(newId));
  return newId;
}

beakon.on("data", (data) => {
  if (data.type === "signal" && simplePeers[data.senderId]) {
    console.log(
      `Received signal from ${data.senderId} (SimplePeer ID: ${
        simplePeers[data.senderId].id
      })`,
      data.content
    );
    simplePeers[data.senderId].signal(JSON.parse(data.content));
  } else {
    console.log(`Data from ${data.senderId}: ${data.content}`);
  }
});

process.stdin.on("data", (data) => {
  Object.values(simplePeers).forEach((sp) => {
    if (sp.connected) {
      sp.send(data.toString().trim());
    }
  });
});
