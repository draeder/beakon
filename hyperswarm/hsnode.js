import Hyperswarm from "hyperswarm";
import crypto from "crypto";

const swarm = Hyperswarm();

const topic = crypto.createHash("sha256").update("your-topic").digest();

swarm.join(topic, { lookup: true, announce: true });

swarm.on("connection", (socket, details) => {
  console.log("New connection from", details.peer);

  socket.on("data", (data) => {
    console.log("Received:", data.toString());
  });

  socket.write("Hello from Node.js peer");
});

swarm.on("error", (err) => {
  console.error("Error:", err);
});
