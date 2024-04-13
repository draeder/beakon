import { expect } from "chai";
import Beakon from "../index.js";
import auth from "../pubnub/auth.js";
import wrtc from "wrtc";
import { describe, it } from "mocha";

const opts = {
  pubnubConfig: auth,
  simplePeerOpts: { wrtc },
  minPeers: 2,
  softCap: 6,
  maxPeers: 9,
  minFanout: 0.33,
  maxFanout: 0.66,
  maxHistory: 10,
  debug: false,
};

const peerCount = 9;
const minPercentageReceived = 90; // Minimum percentage of messages that should be received

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Beakon Networking", function () {
  this.timeout(120_1000);

  it(`${peerCount} peers should send and receive ${minPercentageReceived}% of messages correctly, ignoring announcements and signaling`, async () => {
    const peers = [];
    const messagesToSend = new Set();
    const messagesReceived = new Array(peerCount).fill().map(() => new Set());
    const duplicateCheck = new Array(peerCount).fill().map(() => new Map()); // Maps to check for duplicates

    for (let n = 0; n < peerCount; n++) {
      const beakon = new Beakon(opts);
      beakon.on("peer", (peer) => {
        console.debug("Peer event:", peer.id, peer.state);
      });

      beakon.on("data", (data) => {
        if (data.type === "announce-presence" || data.type === "signal") {
          return;
        }
        // Check for duplicates
        if (duplicateCheck[n].has(data.content)) {
          throw new Error(
            `Duplicate message received by peer ${n}: "${data.content}"`
          );
        }
        duplicateCheck[n].set(data.content, true);
        messagesReceived[n].add(data.content);
      });

      peers.push(beakon);
      await delay(2000); // Ensure peers are initialized
    }

    await delay(5000); // Wait for peer connections to stabilize

    console.log("All peers should now be ready. Starting to send messages.");

    // Sending messages
    peers.forEach((peer, index) => {
      let interval = setInterval(() => {
        const msgContent = Math.random().toString();
        messagesToSend.add(msgContent);
        peer.send({ content: msgContent, type: "user-message" });
      }, 150);
      setTimeout(() => clearInterval(interval), 5000);
    });

    // Wait for all messages to be exchanged
    await delay(5500);

    // Log received messages for debugging
    console.log(
      "messagesReceived:",
      messagesReceived.map((set) => Array.from(set))
    );

    // Verification and Reporting
    const totalMessagesSent = messagesToSend.size;
    messagesReceived.forEach((receivedSet, i) => {
      const receivedCount = receivedSet.size;
      const receivedPercentage = (receivedCount / totalMessagesSent) * 100;
      console.log(
        `Peer ${i} received ${receivedPercentage.toFixed(2)}% of messages.`
      );
      expect(
        receivedPercentage >= minPercentageReceived,
        `Peer ${i} received only ${receivedPercentage.toFixed(
          2
        )}% of messages, which is below the required ${minPercentageReceived}% threshold.`
      ).to.be.true;
    });
  });
});
