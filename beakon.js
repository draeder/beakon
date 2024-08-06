import Beakon from "./index.js";
import auth from "./pubnub/auth.js";
import wrtc from "wrtc";

const opts = {
  pubnubConfig: auth,
  simplePeerOpts: { wrtc: wrtc },
  minPeers: 2,
  softCap: 3,
  maxPeers: 3,
  minFanout: 0.33,
  maxFanout: 0.66,
  maxHistory: 10,
  debug: false, // Enable debug for detailed logs
};

const beakon = new Beakon(opts);

beakon.on("peer", (info) => {
  console.debug("Beakon Peer event:", info.id, info.state);
});

beakon.on("data", (data) => {
  if (data.type === "signal") {
    console.log(`Received signal from ${data.senderId}:`, data.content);
    if (data.senderId in beakon.peers) {
      const peer = beakon.peers[data.senderId];
      try {
        peer.signal(JSON.parse(data.content));
      } catch (error) {
        console.error(`Error signaling peer ${data.senderId}:`, error);
      }
    }
  } else {
    console.log(`Data from ${data.senderId}: ${data.content}`);
  }
});

process.stdin.on("data", (data) => {
  beakon.send({
    type: "message",
    content: data.toString().trim(),
  });
});
