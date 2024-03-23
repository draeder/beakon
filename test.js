import Beakon from "./index.js";
import auth from "./pubnub/auth.js";
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
  debug: false,
};

// Function to pause execution for a given duration
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

(async () => {
  for (let n = 0; n < 5; n++) {
    const beakon = new Beakon(opts);

    beakon.on("peer", (peer) => {
      console.debug("Peer event:", peer.id, peer.state);
      // peer.connection do something with Beakon peer
    });

    let messages = new Set();
    beakon.on("data", (data) => {
      // First, check if the message content already exists in the set
      let isContentFound = false;
      for (let msg of messages) {
        if (msg === data) {
          isContentFound = true;
          break;
        }
      }

      if (!isContentFound) {
        // If the content is not found, add the data object to the set
        messages.add(data);
        console.log(data);
      } else {
        // If the content is found, it means the message is already received
        console.error("Error: message already received from peer!\r\n", data);
        process.exit(1);
      }
    });

    // Add your delay here, for example 1000ms (1 second) between iterations
    process.stdin.on("data", (data) => {
      beakon.send(data.toString().trim());
    });
    await delay(2000);
    if (n < 5) console.debug("DEBUG:", "All peers created.");
  }
})();
