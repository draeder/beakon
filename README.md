# beakon
> A P2P WebRTC signaling service using firebase as a signal server

## Features
- Partial mesh connectivity
- Gossip protocol
- Message history

## Todo features
- Direct messaging
- Message encyryption
- Topic subscriptions
- Video/Audio

### Firebase Preparation
1. Install the firebase cli sdk
2. Create a firebase project with a realtime database
3. Create a file named `auth.js` inside the `web/public` folder and save your firebase information to that file
```js
export default {
  apiKey: "<firebase-api-key>",
  authDomain: "<firebase-api-auth-domain>",
  databaseURL: "<firebase-database-url>",
  projectId: "<firebase-project-id>",
  storageBucket: "<firebase-storage-bucket>",
  messagingSenderId: "<firebase-sender-id>",
  appId: "<firebase-app-id>",
  measurementId: "firebase-measurement-id",
};
```
5. Adjust your firebase database rules as appropriate:
```json
{
  "rules": {
    "clients": {
      ".read": true,
      ".write": true
    },
    "notifications": {
      ".read": true,
      ".write": true
    },
    ".read": true,
  	".write": true
  }
}
```

## Local Development
1. Clone this repo
2. `npm install`
3. `node web/server.js`
4. Navigate to `http://localhost:3000` in multple browser tabs

<!-- ## Install
### Node (coming soon)
```
npm install beakon
```

### Browser (coming soon)
```html
<script type="module" src=""></script>
``` -->

### Usage
#### `send(data [[any]])`
Send a broadcast message to all peers in the partial mesh network

#### `count()`
Return the peers in this peer's partial mesh

### `messages`
Return the message history a peer has