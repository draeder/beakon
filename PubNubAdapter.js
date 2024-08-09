// PubNubAdapter.js
import PubNub from "pubnub";

class PubNubAdapter {
  constructor(config) {
    this.pubnub = new PubNub(config);
    this.listeners = {};
  }

  addListener(listener) {
    this.pubnub.addListener(listener);
  }

  subscribe(channels) {
    this.pubnub.subscribe({ channels });
  }

  publish(message) {
    return this.pubnub.publish(message);
  }
}

export default PubNubAdapter;
