import { initializeApp, applicationDefault } from "firebase-admin/app";
import { getDatabase } from "firebase-admin/database";

// initializeApp({
//   credential: applicationDefault(),
//   databaseURL: "https://beakon-e8674-default-rtdb.firebaseio.com/",
// });

// const db = getDatabase();

// function notifyPeersAboutNewPeer(newPeerId) {
//   const clientsRef = db.ref("clients");
//   clientsRef
//     .get()
//     .then((snapshot) => {
//       if (snapshot.exists()) {
//         const clients = snapshot.val();
//         Object.keys(clients).forEach((clientId) => {
//           if (
//             clientId !== newPeerId &&
//             (clients[clientId].peerCount || 0) < 6
//           ) {
//             console.log("This peer:", clients[clientId].peerCount);
//             return;
//             // Assuming maxPeers is 6
//             const notificationRef = db.ref(
//               `notifications/${clientId}/newPeers`
//             );
//             notificationRef
//               .push({ id: newPeerId })
//               .then(() =>
//                 console.log(`Notified ${clientId} about new peer ${newPeerId}`)
//               )
//               .catch((error) =>
//                 console.error(
//                   `Failed to notify ${clientId} about new peer ${newPeerId}:`,
//                   error
//                 )
//               );
//           } else {
//             return;
//           }
//         });
//       } else {
//         console.log("No clients found.");
//       }
//     })
//     .catch((error) => {
//       console.error("Error reading from clients ref:", error);
//     });
// }

// function registerClient(id, topics) {
//   const clientRef = db.ref(`clients/${id}`);
//   clientRef
//     .set({
//       topics: topics,
//       lastHeartbeat: Date.now(),
//       peerCount: 0, // Initialize peerCount when registering
//     })
//     .then(() => {
//       console.log(`Registered new peer: ${id}`);
//       notifyPeersAboutNewPeer(id);
//     })
//     .catch((error) => {
//       console.error(`Failed to register client ${id}:`, error);
//     });
// }

function cleanupInactiveClients() {
  const clientsRef = db.ref("clients");
  clientsRef
    .get()
    .then((snapshot) => {
      const now = Date.now();
      if (snapshot.exists()) {
        const clients = snapshot.val();
        Object.keys(clients).forEach((clientId) => {
          if (now - clients[clientId].lastHeartbeat > 120000) {
            // 2 minutes
            db.ref(`clients/${clientId}`)
              .remove()
              .then(() =>
                console.log(`Successfully removed inactive client: ${clientId}`)
              )
              .catch((error) =>
                console.error(
                  `Failed to remove inactive client ${clientId}:`,
                  error
                )
              );
          }
        });
      }
    })
    .catch((error) => {
      console.error("Error reading from clients ref:", error);
    });
}

setInterval(cleanupInactiveClients, 60000);

process.on("unhandledRejection", (error) => {
  console.error("Unhandled promise rejection:", error);
});
