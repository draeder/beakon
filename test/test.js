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

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe("Beakon Networking", function () {
  this.timeout(120_1000);

  it("5 peers should send and receive messages correctly", async () => {
    const peers = [];
    const messagesToSend = new Set();
    const messagesReceived = new Array(5).fill(null).map(() => new Set());

    for (let n = 0; n < 5; n++) {
      const beakon = new Beakon(opts);
      beakon.on("peer", (peer) => {
        console.debug("Peer event:", peer.id, peer.state);
      });

      beakon.on("data", (data) => {
        try {
          if (messagesReceived[n].has(data.content))
            throw new Error("Already has!");
        } catch (error) {
          console.log(error);
        }
        messagesReceived[n].add(data.content);
      });

      peers.push(beakon);
      await delay(2000); // Ensure peers are initialized
    }

    // Additional delay to ensure all peers are ready before sending messages
    await delay(5000); // Wait for peer connections to stabilize

    console.log("All peers should now be ready. Starting to send messages.");

    // Sending messages
    peers.forEach((peer, index) => {
      let interval = setInterval(() => {
        const msgContent = Math.random().toString();
        messagesToSend.add(msgContent);
        peer.send({ content: msgContent }); // Sending the message as an object
      }, 150);
      setTimeout(() => {
        clearInterval(interval);
      }, 3000);
    });

    // Wait for all messages to be exchanged
    await delay(10000);

    // Log received messages for debugging
    console.log(
      "messagesReceived:",
      messagesReceived.map((set) => Array.from(set))
    );

    // Verification
    messagesReceived.forEach((receivedSet, i) => {
      messagesToSend.forEach((sentContent) => {
        const hasMessage = receivedSet.has(sentContent);
        expect(
          hasMessage,
          `Peer ${i} did not receive message content: ${sentContent}`
        ).to.be.true;
      });
    });
  });
});
