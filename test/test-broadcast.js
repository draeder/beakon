import { expect } from "chai";
import Beakon from "../index.js";
import auth from "../pubnub/auth.js";
// import wrtc from "wrtc";
import wrtc from "@roamhq/wrtc";
import { describe, it } from "mocha";

const opts = {
  pubnubConfig: auth,
  simplePeerOpts: { wrtc },
  minPeers: 1,
  softCap: 3,
  maxPeers: 3,
  minFanout: 0.33,
  maxFanout: 0.66,
  maxRetries: 6,
  retryInterval: 10,
  maxHistory: 1,
  debug: false, // Enable debug for more detailed logs
};

const peerCount = 20;
const minPercentageReceived = 90; // Minimum percentage of messages that should be received

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Beakon Broadcast Messaging", function () {
  this.timeout(120_000); // Increase timeout for network operations

  it(`${peerCount} peers should send and receive ${minPercentageReceived}% of broadcast messages correctly`, async () => {
    const peers = [];
    const messagesToSend = new Set();
    const messagesReceived = new Array(peerCount).fill().map(() => new Set());
    const duplicateCheck = new Array(peerCount).fill().map(() => new Map()); // Maps to check for duplicates

    // Initialize peers
    for (let n = 0; n < peerCount; n++) {
      const beakon = new Beakon(opts);

      beakon.on("peer", (peer) => {
        console.debug(`Peer event for peer ${n}:`, peer.id, peer.state);
      });

      beakon.on("data", (data) => {
        if (data.type === "announce-presence" || data.type === "signal") {
          return; // Ignore presence announcements and signals
        }
        // Check for duplicates
        if (duplicateCheck[n].has(data.content)) {
          throw new Error(
            `Duplicate message received by peer ${n}: "${data.content}"`
          );
        }
        duplicateCheck[n].set(data.content, true);

        // Track broadcast messages
        if (data.type !== "direct-message") {
          messagesReceived[n].add(data.content);
        }
      });

      peers.push(beakon);
      await delay(2000); // Ensure peers are initialized
    }

    await delay(15000); // Wait for peer connections to stabilize

    console.log(
      "All peers should now be ready. Starting to send broadcast messages."
    );

    // Sending broadcast messages
    peers.forEach((peer) => {
      const interval = setInterval(() => {
        const msgContent = Math.random().toString();
        messagesToSend.add(msgContent);
        peer.send({ content: msgContent, type: "user-message" });
      }, 150);

      // Send messages for 15000ms (15 seconds) instead of 5000ms to ensure over 100 messages are sent
      setTimeout(() => clearInterval(interval), 15000); // This should give roughly 100 messages (15s/150ms = 100)
    });

    // Wait for all messages to be exchanged
    await delay(20000); // Increased delay to allow time for all messages to propagate

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
        `Peer ${i} received ${receivedPercentage.toFixed(
          2
        )}% of broadcast messages.`
      );
      expect(
        receivedPercentage >= minPercentageReceived,
        `Peer ${i} received only ${receivedPercentage.toFixed(
          2
        )}% of broadcast messages, which is below the required ${minPercentageReceived}% threshold.`
      ).to.be.true;
    });
  });
});
