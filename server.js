const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const dotenv = require("dotenv");
const PlayHT = require("playht");
const { streamGptText } = require("./streamGptText.js");
const EventEmitter = require("events");

dotenv.config();

// Set the global maximum number of listeners
EventEmitter.defaultMaxListeners = 100;

// Initialize PlayHT SDK
try {
  PlayHT.init({
    apiKey: process.env.PLAYHT_API_KEY,
    userId: process.env.PLAYHT_USER_ID,
  });
} catch (error) {
  console.log("Failed to initialise PlayHT SDK", error.message);
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  path: "/myws"
});
const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);
let keepAlive;

const setupDeepgram = (socket) => {
  const deepgram = deepgramClient.listen.live({
    language: "en",
    punctuate: true,
    smart_format: true,
    model: "nova",
  });

  if (keepAlive) clearInterval(keepAlive);
  keepAlive = setInterval(() => {
    console.log("deepgram: keepalive");
    deepgram.keepAlive();
  }, 10 * 1000);

  deepgram.addListener(LiveTranscriptionEvents.Open, async () => {
    console.log("deepgram: connected");

    deepgram.addListener(LiveTranscriptionEvents.Close, async () => {
      console.log("deepgram: disconnected");
      clearInterval(keepAlive);
      deepgram.finish();
    });

    deepgram.addListener(LiveTranscriptionEvents.Error, async (error) => {
      console.log("deepgram: error recieved");
      console.error(error);
    });

    deepgram.addListener(LiveTranscriptionEvents.Warning, async (warning) => {
      console.log("deepgram: warning recieved");
      console.warn(warning);
    });

    deepgram.addListener(LiveTranscriptionEvents.Transcript, (data) => {
      console.log("deepgram: packet received");
      console.log("deepgram: transcript received");
      const transcript = data.channel.alternatives[0].transcript ?? "";
      console.log("socket: transcript sent to client");
      socket.emit("transcript", transcript);
      console.log("socket: transcript data sent to client");
      socket.emit("data", data);
    });

    deepgram.addListener(LiveTranscriptionEvents.Metadata, (data) => {
      console.log("deepgram: packet received");
      console.log("deepgram: metadata received");
      console.log("socket: metadata sent to client");
      socket.emit("metadata", data);
    });
  });

  return deepgram;
};

io.on("connection", (socket) => {
  console.log("socket: client connected");
  let deepgram = setupDeepgram(socket);

  socket.on("packet-sent", (data) => {
    console.log("socket: client data received");

    if (deepgram.getReadyState() === 1 /* OPEN */) {
      console.log("socket: data sent to deepgram");
      deepgram.send(data);
    } else if (deepgram.getReadyState() >= 2 /* 2 = CLOSING, 3 = CLOSED */) {
      console.log("socket: data couldn't be sent to deepgram");
      console.log("socket: retrying connection to deepgram");
      /* Attempt to reopen the Deepgram connection */
      deepgram.finish();
      deepgram.removeAllListeners();
      deepgram = setupDeepgram(socket);
    } else {
      console.log("socket: data couldn't be sent to deepgram");
    }
  });

  socket.on("disconnect", () => {
    console.log("socket: client disconnected");
    deepgram.finish();
    deepgram.removeAllListeners();
    deepgram = null;
  });
});

app.use(express.static("public/"));
app.get("/", (req, res) => {
  res.sendFile(__dirname + "/public/index.html");
});

// Endpoint to convert ChatGPT prompt response into audio stream
app.get("/say-prompt", async (req, res) => {
  try {
    const { prompt } = req.query;

    if (!prompt || typeof prompt !== "string") {
      res.status(400).send("ChatGPT prompt not provided in the request");
      return;
    }

    res.setHeader("Content-Type", "audio/mpeg");

    // Measure TTFB for ChatGPT API
    const gptStartTime = Date.now();
    const { stream: gptStream, chatGptTTFB } = await streamGptText(prompt);
    const gptTTFB = Date.now() - gptStartTime;

    var completeGPTResponse = "";
    gptStream.on("data", (chunk) => {
      const payloads = chunk.toString().split("\n\n");
      completeGPTResponse += payloads[0];
    });

    gptStream.on("end", async () => {
      console.log(`GPT Response: ${completeGPTResponse}`);
    });

    // Measure TTFB for PlayHT API
    const playHTStartTime = Date.now();
    let playHTTTFBMeasured = false; // A flag to ensure we measure TTFB only once
    const stream = await PlayHT.stream(gptStream, {
      voiceId:
        "s3://mockingbird-prod/ayla_vo_meditation_d11dd9da-b5f1-4709-95a6-e6d5dc77614a/voices/speaker/manifest.json",
    });

    // Set the TTFB values as response headers
    stream.once("data", () => {
      if (!playHTTTFBMeasured) {
        const playHTTTFB = Date.now() - playHTStartTime;
        playHTTTFBMeasured = true;
        console.log(`ChatGPT TTFB: ${gptTTFB}ms, PlayHT TTFB: ${playHTTTFB}ms`);
        res.setHeader("X-PlayHT-TTFB", playHTTTFB);
        res.setHeader("X-ChatGPT-TTFB", chatGptTTFB);
      }
    });
    // Pipe response audio stream to browser
    stream.pipe(res);
  } catch (error) {
    console.error("Error!!:", error);
    res.status(500).send("Internal Server Error");
  }
});

server.listen(3000, () => {
  console.log("listening on localhost:3000");
});