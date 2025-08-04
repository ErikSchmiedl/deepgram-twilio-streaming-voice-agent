// Import required modules
const fs = require("fs");
const http = require("http");
const path = require("path");
const dotenv = require("dotenv");
dotenv.config();

// Twilio
const HttpDispatcher = require("httpdispatcher");
const WebSocketServer = require("websocket").server;
const dispatcher = new HttpDispatcher();
const wsserver = http.createServer(handleRequest); // Create HTTP server to handle requests

const HTTP_SERVER_PORT = 8080;
let streamSid = '';

const mediaws = new WebSocketServer({
  httpServer: wsserver,
  autoAcceptConnections: true,
});

// Deepgram Speech to Text
const { createClient, LiveTranscriptionEvents } = require("@deepgram/sdk");
const deepgramClient = createClient(process.env.DEEPGRAM_API_KEY);
let keepAlive;

// OpenAI
const OpenAI = require('openai');
const openai = new OpenAI();

// Deepgram TTS WebSocket
const WebSocket = require('ws');
const deepgramTTSWebsocketURL = 'wss://api.deepgram.com/v1/speak?encoding=mulaw&sample_rate=8000&container=none';

// Performance
let llmStart = 0;
let ttsStart = 0;
let firstByte = true;
let speaking = false;
let send_first_sentence_input_time = null;
const chars_to_check = [".", ",", "!", "?", ";", ":"];

// Handle HTTP requests
function handleRequest(request, response) {
  try {
    dispatcher.dispatch(request, response);
  } catch (err) {
    console.error(err);
  }
}

// Debug Route
dispatcher.onGet("/", function (req, res) {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Hello, World!');
});

// Serve test client
dispatcher.onGet("/client", function (req, res) {
  fs.readFile(path.join(__dirname, "client.html"), function (err, data) {
    if (err) {
      res.writeHead(500);
      res.end("Fehler beim Laden der Testseite.");
    } else {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(data);
    }
  });
});

// Twilio XML
dispatcher.onPost("/twiml", function (req, res) {
  let filePath = path.join(__dirname + "/templates", "streams.xml");
  let stat = fs.statSync(filePath);

  res.writeHead(200, {
    "Content-Type": "text/xml",
    "Content-Length": stat.size,
  });

  let readStream = fs.createReadStream(filePath);
  readStream.pipe(res);
});

// WebSocket
mediaws.on("connect", function (connection) {
  console.log("twilio: Connection accepted");
  new MediaStream(connection);
});

// MediaStream
class MediaStream {
  constructor(connection) {
    this.connection = connection;
    this.deepgram = setupDeepgram(this);
    this.deepgramTTSWebsocket = setupDeepgramWebsocket(this);
    connection.on("message", this.processMessage.bind(this));
    connection.on("close", this.close.bind(this));
    this.hasSeenMedia = false;
    this.messages = [];
    this.repeatCount = 0;
  }

  processMessage(message) {
    if (message.type === "utf8") {
      let data = JSON.parse(message.utf8Data);
      if (data.event === "media" && data.media.track == "inbound") {
        if (!this.hasSeenMedia) this.hasSeenMedia = true;
        let rawAudio = Buffer.from(data.media.payload, 'base64');
        this.deepgram.send(rawAudio);
      }
    }
  }

  close() {
    console.log("twilio: Closed");
  }
}

// LLM
async function promptLLM(mediaStream, prompt) {
  const stream = openai.beta.chat.completions.stream({
    model: 'gpt-3.5-turbo',
    stream: true,
    messages: [
      {
        role: 'assistant',
        content: `Du bist ein freundlicher und professioneller Telefonassistent für eine Kfz-Werkstatt.`,
      },
      { role: 'user', content: prompt },
    ],
  });

  speaking = true;
  let firstToken = true;
  for await (const chunk of stream) {
    if (speaking) {
      if (firstToken) {
        firstToken = false;
        firstByte = true;
      }
      const chunk_message = chunk.choices[0].delta.content;
      if (chunk_message) {
        if (!send_first_sentence_input_time && containsAnyChars(chunk_message)) {
          send_first_sentence_input_time = Date.now();
        }
        mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ type: 'Speak', text: chunk_message }));
      }
    }
  }
  mediaStream.deepgramTTSWebsocket.send(JSON.stringify({ type: 'Flush' }));
}

function containsAnyChars(str) {
  return Array.from(str).some(char => chars_to_check.includes(char));
}

// Deepgram TTS
function setupDeepgramWebsocket(mediaStream) {
  const options = {
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
    },
  };
  const ws = new WebSocket(deepgramTTSWebsocketURL, options);

  ws.on('message', function incoming(data) {
    if (speaking) {
      try {
        JSON.parse(data.toString());
      } catch (e) {
        const payload = data.toString('base64');
        const message = {
          event: 'media',
          streamSid: streamSid,
          media: { payload },
        };
        mediaStream.connection.sendUTF(JSON.stringify(message));
      }
    }
  });

  return ws;
}

// Deepgram STT
function setupDeepgram(mediaStream) {
  let is_finals = [];
  const deepgram = deepgramClient.listen.live({
    model: "nova-2-phonecall",
    language: "de",
    smart_format: true,
    encoding: "mulaw",
    sample_rate: 8000,
    channels: 1,
    no_delay: true,
    interim_results: true,
    endpointing: 300,
    utterance_end_ms: 1000,
  });

  deepgram.addListener(LiveTranscriptionEvents.Transcript, (data) => {
    const transcript = data.channel.alternatives[0].transcript;
    if (transcript !== "") {
      if (data.is_final) {
        is_finals.push(transcript);
        if (data.speech_final) {
          const utterance = is_finals.join(" ");
          is_finals = [];
          promptLLM(mediaStream, utterance);
        }
      }
    }
  });

  return deepgram;
}

// Start Server
wsserver.listen(HTTP_SERVER_PORT, function () {
  console.log("Server listening on: http://localhost:%s", HTTP_SERVER_PORT);
});
