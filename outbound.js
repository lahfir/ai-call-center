import Fastify from "fastify";
import WebSocket from "ws";
import dotenv from "dotenv";
import fastifyFormBody from "@fastify/formbody";
import fastifyWs from "@fastify/websocket";
import fastifyIO from "fastify-socket.io";
import Twilio from "twilio";
import fastifyCors from "@fastify/cors";

// Load environment variables from .env file
dotenv.config();

// Check for required environment variables
const {
  ELEVENLABS_API_KEY,
  ELEVENLABS_AGENT_ID,
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_PHONE_NUMBER,
} = process.env;

if (
  !ELEVENLABS_API_KEY ||
  !ELEVENLABS_AGENT_ID ||
  !TWILIO_ACCOUNT_SID ||
  !TWILIO_AUTH_TOKEN ||
  !TWILIO_PHONE_NUMBER
) {
  console.error("Missing required environment variables");
  throw new Error("Missing required environment variables");
}

// Initialize Fastify server
const fastify = Fastify();
fastify.register(fastifyFormBody);
fastify.register(fastifyWs);
fastify.register(fastifyIO, { cors: { origin: "*" } });
fastify.register(fastifyCors, { origin: true });

const PORT = process.env.PORT || 8000;

// Root route for health check
fastify.get("/", async (_, reply) => {
  reply.send({ message: "Server is running" });
});

// Initialize Twilio client
const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

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

// Route to initiate outbound calls
fastify.post("/outbound-call", async (request, reply) => {
  const { number, prompt, first_message } = request.body;

  if (!number) {
    return reply.code(400).send({ error: "Phone number is required" });
  }

  try {
    const call = await twilioClient.calls.create({
      from: TWILIO_PHONE_NUMBER,
      to: number,
      url: `https://${
        request.headers.host
      }/outbound-call-twiml?prompt=${encodeURIComponent(
        prompt
      )}&first_message=${encodeURIComponent(first_message)}`,
    });

    reply.send({
      success: true,
      message: "Call initiated",
      callSid: call.sid,
    });
  } catch (error) {
    console.error("Error initiating outbound call:", error);

    const status = error.status || 500;
    const body = {
      success: false,
      message: error.message || "Failed to initiate call",
      code: error.code,
      moreInfo: error.moreInfo,
    };

    if (error.code === 21219) {
      body.hint =
        "Your Twilio account is in trial mode. Verify the destination number or upgrade the account.";
    }

    reply.code(status).send(body);

    // Push to dashboard in real-time
    try {
      fastify.io.emit("outbound_error", body);
    } catch (_) {}
  }
});

// TwiML route for outbound calls
fastify.all("/outbound-call-twiml", async (request, reply) => {
  const prompt = request.query.prompt || "";
  const first_message = request.query.first_message || "";

  const twimlResponse = `<?xml version="1.0" encoding="UTF-8"?>
      <Response>
        <Connect>
          <Stream url="wss://${request.headers.host}/outbound-media-stream">
            <Parameter name="prompt" value="${prompt}" />
            <Parameter name="first_message" value="${first_message}" />
          </Stream>
        </Connect>
      </Response>`;

  reply.type("text/xml").send(twimlResponse);
});

// WebSocket route for handling media streams
fastify.register(async (fastifyInstance) => {
  fastifyInstance.get(
    "/outbound-media-stream",
    { websocket: true },
    (ws, req) => {
      console.info("[Server] Twilio connected to outbound media stream");

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

            // Send initial configuration with prompt and first message
            const initialConfig = {
              type: "conversation_initiation_client_data",
              conversation_config_override: {
                agent: {
                  prompt: {
                    prompt:
                      customParameters?.prompt ||
                      "you are a gary from the phone store",
                  },
                  first_message:
                    customParameters?.first_message ||
                    "hey there! how can I help you today?",
                },
              },
            };

            console.log(
              "[ElevenLabs] Sending initial config with prompt:",
              initialConfig.conversation_config_override.agent.prompt.prompt
            );

            // Send the configuration to ElevenLabs
            elevenLabsWs.send(JSON.stringify(initialConfig));
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
                  fastify.io.emit("agent_response", {
                    callSid,
                    text: agentAnswer,
                  });
                  break;

                case "user_transcript":
                  const userSpeech =
                    message.user_transcription_event?.user_transcript;
                  console.log(`[Twilio] User transcript: ${userSpeech}`);
                  fastify.io.emit("user_transcript", {
                    callSid,
                    text: userSpeech,
                  });
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
              ws.__streamSid = streamSid;
              activeTwilioWs.set(callSid, ws);
              customParameters = msg.start.customParameters; // Store parameters
              console.log(
                `[Twilio] Stream started - StreamSid: ${streamSid}, CallSid: ${callSid}`
              );
              console.log(
                `[Twilio] Start message customParameters: ${JSON.stringify(
                  customParameters || {}
                )}`
              );
              break;

            case "media":
              const track = msg.media.track || "unknown";
              const size = msg.media.payload.length;
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

          // Broadcast every raw ElevenLabs message if you wish
          fastify.io.emit("elevenlabs_raw", msg);
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
      });
    }
  );
});

const activeTwilioWs = new Map();

// Defer Socket.IO event wiring until Fastify is ready (io instance attached)
fastify.ready(() => {
  if (fastify.__outboundSocketSetup) return;
  fastify.__outboundSocketSetup = true;

  const io = fastify.io;
  if (!io) {
    console.error("[Server] fastify.io not initialized");
    return;
  }

  io.on("connection", (client) => {
    console.log("[Socket.IO] Client connected", client.id);

    client.onAny((event, payload) => {
      if (event !== "heartbeat") {
        console.log(`[Socket.IO] Event received: ${event}`, payload);
      }
    });

    client.on("end_call", ({ callSid }) => {
      const wsToClose = callSid
        ? activeTwilioWs.get(callSid)
        : [...activeTwilioWs.values()][0];
      if (!wsToClose) {
        client.emit("error", { message: "No active call to end" });
        return;
      }
      const csid = callSid || [...activeTwilioWs.keys()][0];
      wsToClose.close();
      activeTwilioWs.delete(csid);
      client.emit("call_ended", { callSid: csid });
    });

    client.on("say_text", async ({ callSid, text }) => {
      const twilioWs = callSid
        ? activeTwilioWs.get(callSid)
        : [...activeTwilioWs.values()][0];
      if (!twilioWs || twilioWs.readyState !== WebSocket.OPEN) {
        client.emit("error", { message: "Call not active" });
        return;
      }
      if (!text) {
        client.emit("error", { message: "Missing text" });
        return;
      }
      console.log(`[Server] say_text (outbound) → ${text}`);
      await streamTtsToTwilio(twilioWs, text);
    });

    client.on("disconnect", (reason) => {
      console.log(`[Socket.IO] Client ${client.id} disconnected (${reason})`);
    });
  });
});

const ELEVENLABS_VOICE_ID =
  process.env.ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";

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
        body: JSON.stringify({ text, output_format: "ulaw_8000" }),
      }
    );
    if (!ttsResp.ok) {
      console.error("[ElevenLabs] TTS request failed", await ttsResp.text());
      return;
    }
    const arrayBuffer = await ttsResp.arrayBuffer();
    const b64 = Buffer.from(arrayBuffer).toString("base64");
    const CHUNK = 1000;
    for (let i = 0; i < b64.length; i += CHUNK) {
      const mediaMsg = {
        event: "media",
        streamSid: ws.__streamSid,
        media: { payload: b64.slice(i, i + CHUNK) },
      };
      ws.send(JSON.stringify(mediaMsg));
    }
  } catch (e) {
    console.error("[Server] TTS error", e);
  }
}

// Endpoint to trigger ElevenLabs batch calling
fastify.post("/batch-calling", async (request, reply) => {
  try {
    const { recipients } = request.body || {};
    if (!Array.isArray(recipients) || recipients.length === 0) {
      return reply
        .code(400)
        .send({ success: false, message: "Missing recipients array" });
    }

    const batchPayload = {
      call_name: `batch_${Date.now()}`,
      agent_id: ELEVENLABS_AGENT_ID,
      agent_phone_number_id: process.env.ELEVENLABS_PHONE_NUMBER_ID || "",
      scheduled_time_unix: Math.floor(Date.now() / 1000),
      recipients: recipients.map((p) =>
        typeof p === "string" ? { phone_number: p } : p
      ),
    };

    const elResp = await fetch(
      "https://api.elevenlabs.io/v1/convai/batch-calling/submit",
      {
        method: "POST",
        headers: {
          "xi-api-key": ELEVENLABS_API_KEY,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(batchPayload),
      }
    );

    const data = await elResp.json();
    if (!elResp.ok) {
      console.error("[ElevenLabs] Batch call error", data);
      return reply.code(elResp.status).send({ success: false, error: data });
    }

    reply.send({ success: true, data });
  } catch (err) {
    console.error("[Server] Batch calling error", err);
    reply.code(500).send({ success: false, message: "Internal server error" });
  }
});

// REST fallback (must be declared before listen)
fastify.post("/end_call", async (request, reply) => {
  const { callSid } = request.body || {};
  const wsToClose = callSid
    ? activeTwilioWs.get(callSid)
    : [...activeTwilioWs.values()][0];
  if (wsToClose && wsToClose.readyState === WebSocket.OPEN) {
    wsToClose.close();
    activeTwilioWs.delete(callSid);
    return { success: true };
  }
  reply.code(404).send({ success: false, message: "Call not found" });
});

// Start the Fastify server
fastify.listen({ port: PORT, host: "0.0.0.0" }, (err) => {
  if (err) {
    console.error("Error starting server:", err);
    process.exit(1);
  }
  console.log(`[Server] Listening on port ${PORT}`);
});
