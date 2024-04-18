const OpenAI = require("openai");
const { Readable } = require("stream");
const dotenv = require("dotenv");
dotenv.config();

let openai;
try {
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
} catch (error) {
  console.log("Failed to initialise OpenAI SDK", error.message);
}

// ChatGPT's API returns an object. Convert it to a string with just the text.
async function streamGptText(prompt) {
  if (!openai) {
    throw "OpenAI API not initialised";
  }

  const startTime = Date.now();
  // Create a stream of GPT-3 responses
  const newPrompt = prompt;
  const chatGptResponseStream = await openai.chat.completions.create({
    messages: [
      {
        role: "system",
        content:
          "You are a helpful AI assistant.",
      },
      { role: "user", content: newPrompt },
    ],
    model: "gpt-3.5-turbo",
    stream: true,
  });

  const [stream1, stream2] = chatGptResponseStream.tee(); // Split the stream

  let firstByteReceivedTime;
  const stream = new Readable({
    async read() {
      for await (const part of stream1) {
        if (!firstByteReceivedTime) {
          firstByteReceivedTime = Date.now();
        }
        // Add only the text to the stream
        this.push(part.choices[0]?.delta?.content || "");
      }
      this.push(null);
    },
  });
  const chatGptTTFB = firstByteReceivedTime - startTime;
  return { stream, chatGptTTFB };
}

module.exports = { streamGptText };