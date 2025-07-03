import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import fastifyIO from "fastify-socket.io";
import fastifyCors from "@fastify/cors";

// Load environment variables from .env file
dotenv.config();

const { ELEVENLABS_AGENT_ID, ELEVENLABS_API_KEY } = process.env;
const ELEVENLABS_VOICE_ID =
  process.env.ELEVENLABS_VOICE_ID || "EXAVITQu4vr4xnSDxMaL"; // default voice ID

// Check for the required ElevenLabs Agent ID
if (!ELEVENLABS_AGENT_ID || !ELEVENLABS_API_KEY) {
  console.error(
    "Missing ELEVENLABS_AGENT_ID or ELEVENLABS_API_KEY in environment variables"
  );
  process.exit(1);
}

// Initialize Fastify server
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);
fastify.register(fastifyIO, { cors: { origin: "*" } });
fastify.register(fastifyCors, { origin: true });

const PORT = process.env.PORT || 8000;

const activeTwilioWs = new Map();

fastify.io.on("connection", (client) => {
  client.on("end_call", ({ callSid }) => {
    if (!callSid) return;
    const twilioWs = activeTwilioWs.get(callSid);
    if (twilioWs && twilioWs.readyState === WebSocket.OPEN) {
      console.log(`[Server] Received end_call for ${callSid}. Closing WS.`);
      twilioWs.close();
      activeTwilioWs.delete(callSid);
      client.emit("call_ended", { callSid });
    }
  });

  client.on("say_text", async ({ callSid, text }) => {
    const twilioWs = activeTwilioWs.get(callSid);
    if (!twilioWs || twilioWs.readyState !== WebSocket.OPEN) {
      client.emit("error", { message: "Call not active" });
      return;
    }
    console.log(`[Server] say_text → ${text}`);
    await streamTtsToTwilio(twilioWs, text);
  });
});

fastify.post("/end_call", async (request, reply) => {
  const { callSid } = request.body || {};
  const twilioWs = activeTwilioWs.get(callSid);
  if (twilioWs && twilioWs.readyState === WebSocket.OPEN) {
    twilioWs.close();
    activeTwilioWs.delete(callSid);
    return { success: true };
  }
  reply
    .code(404)
    .send({ success: false, message: "Call not found or already closed" });
});

// Root route for health check
fastify.get("/", async (_, reply) => {
  reply.send({ message: "Server is running" });
});

// Route to handle incoming calls from Twilio
fastify.all("/twilio/inbound_call", async (request, reply) => {
  // Generate TwiML response to connect the call to a WebSocket stream
  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
    <Response>
      <Connect>
        <Stream url="wss://${request.headers.host}/media-stream" />
      </Connect>
    </Response>`;

  reply.type("text/xml").send(twimlResponse);
});

// Helper function to get signed URL for authenticated conversations
async function getSignedUrl() {
  try {
    const response = await fetch(
      `https://api.elevenlabs.io/v1/convai/conversation/get_signed_url?agent_id=${ELEVENLABS_AGENT_ID}`,
      {
        method: "GET",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
        },
      }
    );

    if (!response.ok) {
      throw new Error(`Failed to get signed URL: ${response.statusText}`);
    }

    const data = await response.json();
    return data.signed_url;
  } catch (error) {
    console.error("Error getting signed URL:", error);
    throw error;
  }
}

// WebSocket route for handling media streams
fastify.register(async (fastifyInstance) => {
  fastifyInstance.get("/media-stream", { websocket: true }, (ws, req) => {
    console.info("[Server] Twilio connected to media stream");

    // Variables to track the call
    let streamSid = null;
    let callSid = null;
    let elevenLabsWs = null;
    let customParameters = null; // Add this to store parameters

    // Handle WebSocket errors
    ws.on("error", console.error);

    // Set up ElevenLabs connection
    const setupElevenLabs = async () => {
      try {
        const signedUrl = await getSignedUrl();
        elevenLabsWs = new WebSocket(signedUrl);

        elevenLabsWs.on("open", () => {
          console.log("[ElevenLabs] Connected to Conversational AI");
        });

        elevenLabsWs.on("message", (data) => {
          try {
            const message = JSON.parse(data);

            switch (message.type) {
              case "conversation_initiation_metadata":
                console.log("[ElevenLabs] Received initiation metadata");
                break;

              case "audio":
                if (streamSid) {
                  const chunkSize =
                    message.audio?.chunk?.length ||
                    message.audio_event?.audio_base_64?.length ||
                    0;
                  console.log(
                    `[ElevenLabs] Forwarding audio chunk to Twilio (${chunkSize} bytes)`
                  );
                  if (message.audio?.chunk) {
                    const audioData = {
                      event: "media",
                      streamSid,
                      media: {
                        payload: message.audio.chunk,
                      },
                    };
                    ws.send(JSON.stringify(audioData));
                  } else if (message.audio_event?.audio_base_64) {
                    const audioData = {
                      event: "media",
                      streamSid,
                      media: {
                        payload: message.audio_event.audio_base_64,
                      },
                    };
                    ws.send(JSON.stringify(audioData));
                  }
                } else {
                  console.log(
                    "[ElevenLabs] Received audio but no StreamSid yet"
                  );
                }
                break;

              case "interruption":
                if (streamSid) {
                  ws.send(
                    JSON.stringify({
                      event: "clear",
                      streamSid,
                    })
                  );
                }
                break;

              case "ping":
                if (message.ping_event?.event_id) {
                  elevenLabsWs.send(
                    JSON.stringify({
                      type: "pong",
                      event_id: message.ping_event.event_id,
                    })
                  );
                }
                break;

              case "agent_response":
                const agentAnswer =
                  message.agent_response_event?.agent_response;
                console.log(`[Twilio] Agent response: ${agentAnswer}`);
                fastify.io.emit("agent_response", { text: agentAnswer });
                break;

              case "user_transcript":
                const userSpeech =
                  message.user_transcription_event?.user_transcript;
                console.log(`[Twilio] User transcript: ${userSpeech}`);
                fastify.io.emit("user_transcript", { text: userSpeech });
                break;

              default:
                console.log(
                  `[ElevenLabs] Unhandled message type: ${message.type}`
                );
            }
          } catch (error) {
            console.error("[ElevenLabs] Error processing message:", error);
          }
        });

        elevenLabsWs.on("error", (error) => {
          console.error("[ElevenLabs] WebSocket error:", error);
        });

        elevenLabsWs.on("close", () => {
          console.log("[ElevenLabs] Disconnected");
        });
      } catch (error) {
        console.error("[ElevenLabs] Setup error:", error);
      }
    };

    // Set up ElevenLabs connection
    setupElevenLabs();

    // Handle messages from Twilio
    ws.on("message", (message) => {
      try {
        const msg = JSON.parse(message);
        if (msg.event !== "media") {
          console.log(`[Twilio] Received event: ${msg.event}`);
        }

        switch (msg.event) {
          case "start":
            streamSid = msg.start.streamSid;
            callSid = msg.start.callSid;
            ws.__streamSid = streamSid; // store for TTS helper
            activeTwilioWs.set(callSid, ws);
            console.log(
              `[Twilio] Stream started - StreamSid: ${streamSid}, CallSid: ${callSid}`
            );
            console.log(
              `[Twilio] Start message customParameters: ${JSON.stringify(
                msg.start.customParameters || {}
              )}`
            );
            break;

          case "media":
            const track = msg.media.track || "unknown";
            const size = msg.media.payload.length;
            console.log(
              `[Twilio] Media event on track: ${track} (payload ${size} bytes)`
            );
            if (!track || track === "inbound") {
              if (elevenLabsWs?.readyState === WebSocket.OPEN) {
                const audioMessage = {
                  user_audio_chunk: msg.media.payload,
                };
                elevenLabsWs.send(JSON.stringify(audioMessage));
              }
            } else {
              console.log(
                `[Twilio] Skipping non-inbound media track: ${track}`
              );
            }
            break;

          case "stop":
            console.log(`[Twilio] Stream ${streamSid} ended`);
            activeTwilioWs.delete(callSid);
            if (elevenLabsWs?.readyState === WebSocket.OPEN) {
              elevenLabsWs.close();
            }
            break;

          default:
            console.log(`[Twilio] Unhandled event: ${msg.event}`);
        }

        fastify.io.emit("twilio_event", { event: msg.event, data: msg });
        fastify.io.emit(`twilio_${msg.event}`, msg);
      } catch (error) {
        console.error("[Twilio] Error processing message:", error);
      }
    });

    // Handle WebSocket closure
    ws.on("close", () => {
      console.log("[Twilio] Client disconnected");
      activeTwilioWs.delete(callSid);
      if (elevenLabsWs?.readyState === WebSocket.OPEN) {
        elevenLabsWs.close();
      }
    });
  });
});

async function streamTtsToTwilio(ws, text) {
  try {
    const ttsResp = await fetch(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      {
        method: "POST",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          text,
          output_format: "ulaw_8000",
        }),
      }
    );
    if (!ttsResp.ok) {
      console.error("[ElevenLabs] TTS request failed", await ttsResp.text());
      return;
    }
    const arrayBuffer = await ttsResp.arrayBuffer();
    const base64Audio = Buffer.from(arrayBuffer).toString("base64");

    const CHUNK_SIZE = 1000;
    for (let i = 0; i < base64Audio.length; i += CHUNK_SIZE) {
      const chunk = base64Audio.slice(i, i + CHUNK_SIZE);
      const mediaMsg = {
        event: "media",
        streamSid: ws.__streamSid,
        media: { payload: chunk },
      };
      ws.send(JSON.stringify(mediaMsg));
    }
  } catch (err) {
    console.error("[Server] Error generating or sending TTS:", err);
  }
}

// Start the Fastify server
fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error("Error starting server:", err);
    process.exit(1);
  }
  console.log(`[Server] Listening on port ${PORT}`);
});
