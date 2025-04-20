// File: api/process-voice.js
import fetch from 'node-fetch';
import { SpeechClient } from '@google-cloud/speech';
import { TextToSpeechClient } from '@google-cloud/text-to-speech';
// 'stream' is imported but not used unless you implement streaming responses later.
// import stream from 'stream';

// --- Configuration ---
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
if (!GEMINI_API_KEY) {
    console.warn("GEMINI_API_KEY environment variable is not set.");
    // Consider throwing an error here if the key is absolutely required at startup
    // throw new Error("FATAL: Gemini API Key not configured in environment variables.");
}

// --- Google Cloud Credentials Handling ---
// Determines how Google Cloud clients authenticate.
let googleCredentials = undefined;
// Option 1 (Recommended for Vercel): Parse credentials from an environment variable.
// Set GOOGLE_CREDENTIALS_JSON with the *content* of your service account key file.
if (process.env.GOOGLE_CREDENTIALS_JSON) {
    try {
        googleCredentials = JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON);
        console.log("Using Google Cloud credentials from GOOGLE_CREDENTIALS_JSON env var.");
    } catch (e) {
        console.error("Failed to parse GOOGLE_CREDENTIALS_JSON. Ensure it contains valid JSON:", e);
        // Decide if this is a fatal error depending on your setup
    }
}
// Option 2 (Common for Local Development): Use GOOGLE_APPLICATION_CREDENTIALS.
// Set GOOGLE_APPLICATION_CREDENTIALS to the *path* of your service account key file.
// The Google Cloud client libraries automatically detect this variable.
// If GOOGLE_CREDENTIALS_JSON is set (Option 1), it takes precedence.
else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
     console.log("Using Google Cloud credentials from GOOGLE_APPLICATION_CREDENTIALS env var (path).");
     // No need to load the file here, the client library handles it.
} else {
    console.warn("No Google Cloud credentials explicitly configured. Attempting default ADC (Application Default Credentials). This might work in some Cloud environments but requires setup locally (gcloud auth application-default login).");
}


// --- Initialize Google Cloud Clients ---
// Pass credentials explicitly if loaded from GOOGLE_CREDENTIALS_JSON,
// otherwise, let the library use ADC (which includes GOOGLE_APPLICATION_CREDENTIALS).
const clientOptions = googleCredentials ? { credentials: googleCredentials } : {};
const speechClient = new SpeechClient(clientOptions);
const textToSpeechClient = new TextToSpeechClient(clientOptions);


// --- Google Cloud Speech-to-Text (STT) ---
/**
 * Transcribes audio content provided as a base64 string using Google Cloud STT.
 * @param {string} audioBase64 - The base64 encoded audio data.
 * @returns {Promise<string>} - The transcribed text.
 * @throws {Error} - If transcription fails or returns empty.
 */
async function transcribeAudio(audioBase64) {
    console.log("Calling Google STT API...");
    const audio = {
        content: audioBase64,
    };

    // ** STT Configuration **
    // Critical: Match these settings to how the audio was recorded in your frontend (e.g., Expo AV).
    const config = {
         // --- Encoding ---
         // Choose ONE based on your recording format:
         encoding: 'MP3',         // Use if your frontend records/sends MP3. Common & efficient.
         // encoding: 'LINEAR16', // Use for raw, uncompressed PCM audio (often WAV). High quality but large file size.
         // encoding: 'AMR',      // Common for older mobile devices/recordings (often in .amr files).
         // encoding: 'AMR_WB',   // Wideband version of AMR.
         // encoding: 'WEBM_OPUS' // Common for web-based recording (MediaRecorder API).
         // encoding: 'OGG_OPUS'  // Another Opus container.
         // Check Google STT docs for all supported encodings.

         // --- Sample Rate ---
         // Match the sample rate of your recording (e.g., 8000, 16000, 44100, 48000 Hz).
         // 16000 Hz is a good balance for voice quality and performance.
         sampleRateHertz: 16000,

         // --- Language ---
         languageCode: 'en-US', // Adjust if needed, e.g., 'en-GB', 'es-ES'

         // --- Optional Enhancements ---
         // model: 'telephony', // Use for audio recorded over phone lines. Other options: 'latest_long', 'medical_dictation', etc.
         // useEnhanced: true, // Use enhanced models for potentially higher accuracy (may cost more).
         // enableAutomaticPunctuation: true, // Let Google add punctuation.
    };

    const request = {
        audio: audio,
        config: config,
    };

    try {
        const [response] = await speechClient.recognize(request);
        const transcription = response.results
            ?.map(result => result.alternatives?.[0]?.transcript)
            .join('\n')
            .trim(); // Trim whitespace

        if (!transcription) {
            console.warn("Google STT returned an empty transcription.");
            // Decide if empty transcription is an error or just means silence
            // For this use case, let's treat it as potentially valid (silence) but log it.
            // If you require non-empty input, throw an error here:
            // throw new Error("Google STT returned empty transcription.");
             return ""; // Return empty string for silence or no discernible speech
        }

        console.log(`Google STT Transcription: "${transcription}"`);
        return transcription;
    } catch (error) {
        console.error('Error calling Google STT API:', error.message || error);
        // More specific error handling could be added based on error codes if needed
        throw new Error(`Failed to transcribe audio. Reason: ${error.message}`);
    }
}

// --- Gemini API Call ---
/**
 * Sends the user's transcript to the Gemini API and expects a JSON response
 * containing an emotion label and a reply text.
 * @param {string} userTranscript - The text transcribed from user's audio.
 * @returns {Promise<{emotion: string, reply: string}>} - The parsed emotion and reply.
 * @throws {Error} - If the API call fails or the response is invalid.
 */
async function getGeminiResponse(userTranscript) {
    if (!GEMINI_API_KEY) {
        throw new Error("Gemini API Key is not configured. Cannot call the API.");
    }
    if (!userTranscript) {
        console.log("User transcript is empty, returning default response.");
        // Handle empty transcript gracefully - maybe a default "I didn't hear anything" response
        return { emotion: 'neutral', reply: "I didn't quite catch that. Could you please speak again?" };
    }

    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_API_KEY}`;

    // --- System Prompt ---
    // Define the persona and expected output format for Gemini.
    // IMPORTANT: Ensure your full prompt clearly instructs the model to ONLY output JSON
    // in the specified format: {"emotion": "...", "reply": "..."}
    const systemPrompt = `
You are 'Aura', a compassionate, warm, and understanding mental wellness companion.
Your goal is to listen actively, validate feelings, and offer supportive, non-judgmental responses.
Analyze the user's text for the primary underlying emotion.
Respond ONLY in the following JSON format, with no other text before or after the JSON block:
{"emotion": "primary_emotion_label", "reply": "your_empathetic_response_text_here"}

Available primary emotion labels: sadness, joy, anger, fear, anxiety, surprise, disgust, neutral, love, calm. Choose the most fitting one.

User Text:
"${userTranscript}"

Your JSON Response:
`; // Ensure no trailing spaces or newlines in the prompt string itself if it causes issues

    const requestBody = {
        contents: [{
            parts: [{ text: systemPrompt }]
        }],
        generationConfig: {
            temperature: 0.7,       // Controls randomness (lower = more deterministic)
            maxOutputTokens: 250,   // Max length of the generated response
            // topP: 0.9,           // Nucleus sampling (alternative to temperature)
            // topK: 40,            // Consider only top K likely tokens
            // responseMimeType: "application/json", // Can try asking Gemini to output JSON directly
        },
        safetySettings: [ // Configure content safety filters
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
        ]
    };

    try {
        console.log("Calling Gemini API...");
        const response = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(requestBody),
        });

        if (!response.ok) {
            const errorBody = await response.text();
            console.error(`Gemini API Error Response (${response.status}):`, errorBody);
            throw new Error(`Gemini API request failed: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        console.log("Gemini API Raw Response:", JSON.stringify(data, null, 2));

        // --- Robust Response Parsing ---
        const candidate = data?.candidates?.[0];
        let generatedText = candidate?.content?.parts?.[0]?.text?.trim() || '';

        if (!generatedText) {
             if (candidate?.finishReason && candidate.finishReason !== 'STOP') {
                 console.warn(`Gemini generation stopped due to ${candidate.finishReason}.`);
                 // Handle safety blocks or other reasons if necessary
                 throw new Error(`Gemini response generation failed: ${candidate.finishReason}`);
             }
             throw new Error("Gemini response is empty or missing text content.");
        }

        let parsedResponse = null;
        try {
            // Attempt 1: Try parsing the text directly as JSON
            parsedResponse = JSON.parse(generatedText);
        } catch (directParseError) {
            console.warn("Direct JSON parsing failed. Attempting to clean markdown fences...");
            // Attempt 2: If direct parse fails, try removing potential markdown code fences
            // Matches ```json ... ``` or ``` ... ```
            const jsonMatch = generatedText.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
            if (jsonMatch && jsonMatch[1]) {
                try {
                    parsedResponse = JSON.parse(jsonMatch[1].trim());
                    console.log("Successfully parsed after cleaning markdown fences.");
                } catch (markdownParseError) {
                    console.error("Failed to parse JSON even after cleaning markdown:", markdownParseError);
                    // Keep generatedText as fallback
                }
            } else {
                console.warn("Could not find markdown JSON block.");
                // Keep generatedText as fallback
            }
        }

        // Validate the parsed structure or use fallback
        if (parsedResponse && parsedResponse.emotion && parsedResponse.reply) {
            console.log("Parsed Gemini Response:", parsedResponse);
            // Basic validation (can add more specific checks)
             if (typeof parsedResponse.emotion !== 'string' || typeof parsedResponse.reply !== 'string') {
                 console.warn("Parsed response fields have incorrect types.");
                 throw new Error("Invalid format in parsed Gemini JSON response.");
             }
            return parsedResponse;
        } else {
            // Fallback if parsing failed or structure is wrong
            console.error("Failed to parse valid JSON response from Gemini or required fields missing. Falling back.");
            // Return the raw text as the reply, and a neutral emotion
            return {
                emotion: 'neutral',
                reply: generatedText || "I heard you, but I'm having trouble formulating a response right now."
            };
        }

    } catch (error) {
        console.error('Error during Gemini API call or processing:', error);
        // Don't re-throw the generic Error from the catch block if it's already specific enough
        if (error instanceof Error && error.message.startsWith('Gemini API')) {
             throw error; // Re-throw specific API errors
        }
        throw new Error(`Failed to get response from AI assistant. Reason: ${error.message}`);
    }
}


// --- Google Cloud Text-to-Speech (TTS) ---
/**
 * Synthesizes text into speech using Google Cloud TTS, adjusting voice characteristics based on emotion.
 * @param {string} textToSpeak - The text to synthesize.
 * @param {string} emotion - The detected emotion to influence the voice.
 * @returns {Promise<string>} - Base64 encoded MP3 audio data.
 * @throws {Error} - If speech synthesis fails.
 */
async function getGoogleTTS(textToSpeak, emotion) {
    console.log(`Calling Google TTS API for emotion: ${emotion || 'neutral'}`);

    // --- Voice Configuration ---
    // See Google TTS docs for available voices: https://cloud.google.com/text-to-speech/docs/voices
    let ssmlGender = 'FEMALE'; // Default gender
    let voiceName = 'en-US-Wavenet-F'; // Default female WaveNet voice (high quality)
    // Other good options: en-US-Standard-F, en-US-Neural2-F

    // --- Emotion-based SSML Adjustments ---
    // These are examples; fine-tune based on testing and desired effect.
    let rate = 1.0;  // Normal speaking rate
    let pitch = 0;   // Normal pitch (in semitones)

    switch (emotion?.toLowerCase()) {
        case 'sadness':
            pitch = -2.5; // Lower pitch
            rate = 0.9;  // Slower rate
            voiceName = 'en-US-Wavenet-F'; // Example female voice
            ssmlGender = 'FEMALE';
            break;
        case 'joy':
        case 'love':
            pitch = 1.5; // Higher pitch
            rate = 1.1;  // Faster rate
             // Example: Maybe use a different voice entirely for joy
            voiceName = 'en-US-Wavenet-A'; // Example Male Wavenet voice
            ssmlGender = 'MALE';
            break;
        case 'anxiety':
        case 'fear':
            pitch = 0.5;  // Slightly higher pitch
            rate = 1.05; // Slightly faster rate
            // Consider adding slight pauses or variations if possible with more complex SSML
            break;
        case 'anger':
             pitch = -1.0; // Slightly lower pitch
             rate = 1.0;   // Normal or slightly faster rate
             // Maybe choose a voice known for a sharper tone if available
             voiceName = 'en-US-Wavenet-D'; // Example Male Wavenet voice
             ssmlGender = 'MALE';
            break;
        case 'surprise':
             pitch = 1.0;
             rate = 1.1;
             break;
        // Add more cases for 'disgust', 'calm', 'neutral', etc.
        case 'calm':
        case 'neutral':
        default:
            // Use default rate, pitch, and voice
            break;
    }

    // --- SSML Generation ---
    // Escape XML characters in the text to prevent SSML injection or errors.
    const escapedText = textToSpeak
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');

    // Construct the SSML string. Using <prosody> to adjust rate and pitch.
    const ssml = `<speak><prosody rate="${rate.toFixed(2)}" pitch="${pitch.toFixed(1)}st">${escapedText}</prosody></speak>`;

    const request = {
        input: { ssml: ssml }, // Use SSML input
        voice: {
            languageCode: 'en-US', // Match language code
            name: voiceName,       // Selected voice name
            ssmlGender: ssmlGender // Specify gender (optional but good practice with SSML)
        },
        // Select audio encoding format. MP3 is widely compatible.
        // Other options: LINEAR16 (WAV), OGG_OPUS
        audioConfig: { audioEncoding: 'MP3' },
    };

    try {
        const [response] = await textToSpeechClient.synthesizeSpeech(request);
        // The audio content is returned as a Buffer, convert it to base64.
        const audioBase64 = response.audioContent.toString('base64');
        console.log("Received audio from Google TTS, returning base64 (length preview):", audioBase64.length > 50 ? audioBase64.substring(0, 50) + '...' : audioBase64);
        return audioBase64;
    } catch (error) {
        console.error('Error calling Google TTS API:', error.message || error);
        throw new Error(`Failed to synthesize speech. Reason: ${error.message}`);
    }
}


// --- Main Vercel Serverless Function Handler ---
export default async function handler(req, res) {
    // Only allow POST requests
    if (req.method !== 'POST') {
        console.log(`Method Not Allowed: ${req.method}`);
        // Set Allow header for 405 responses
        res.setHeader('Allow', ['POST']);
        return res.status(405).json({ message: `Method ${req.method} Not Allowed` });
    }

    console.log("Processing new voice request...");

    try {
        // Expecting { "audioBase64": "..." } in the JSON request body
        const { audioBase64 } = req.body;

        if (!audioBase64 || typeof audioBase64 !== 'string') {
             console.error("Bad Request: Missing or invalid 'audioBase64' string in request body.");
            return res.status(400).json({ message: "Missing or invalid 'audioBase64' in request body. Ensure it's a non-empty string." });
        }
        console.log("Received audio data (base64 length):", audioBase64.length);


        // --- Step 1: Transcribe Audio using Google STT ---
        const transcript = await transcribeAudio(audioBase64);
        // If transcription is empty (e.g., silence), we might still proceed or handle differently
        if (transcript === "" ) {
             console.log("Transcription resulted in empty string (likely silence).");
             // Option: Send a specific response for silence
             // return res.status(200).json({
             //    emotion: 'neutral',
             //    reply: "I didn't hear anything. Can you speak up?",
             //    audioBase64: await getGoogleTTS("I didn't hear anything. Can you speak up?", 'neutral'), // Synthesize this response
             //    transcript: ""
             // });
             // Or continue to Gemini with the empty transcript if handled there
        }


        // --- Step 2: Get Emotion and Reply from Gemini ---
        const geminiResult = await getGeminiResponse(transcript);
        const { emotion, reply } = geminiResult; // Destructure validated result
        console.log(`Gemini Result - Emotion: ${emotion}, Reply: "${reply}"`);


        // --- Step 3: Synthesize Reply using Google TTS ---
        const ttsAudioBase64 = await getGoogleTTS(reply, emotion);


        // --- Step 4: Send Successful Response ---
        // Return the transcript, Gemini's analysis (emotion/reply), and the synthesized audio
        console.log("Successfully processed request. Sending response.");
        res.status(200).json({
            transcript: transcript,    // The text derived from user's audio
            emotion: emotion || 'neutral', // The emotion label from Gemini
            reply: reply,              // The text reply generated by Gemini
            audioBase64: ttsAudioBase64 // The base64 encoded audio of the reply
        });

    } catch (error) {
        // --- Centralized Error Handling ---
        console.error("Error processing voice request:", error);

        // Determine appropriate status code (default to 500)
        let statusCode = 500;
        if (error.message.includes("Failed to transcribe") ||
            error.message.includes("Failed to synthesize") ||
            error.message.includes("Gemini API request failed")) {
            statusCode = 502; // Bad Gateway - upstream API failed
        } else if (error.message.includes("invalid format")) {
            statusCode = 500; // Internal error processing response
        } else if (error.message.includes("not configured")) {
            statusCode = 500; // Internal configuration error
        }

        // Send a generic error message to the client
        res.status(statusCode).json({
             message: error.message || 'An internal server error occurred while processing your request.'
             // Optionally include an error code or ID for tracking
             // errorCode: 'PROCESS_VOICE_FAILED'
        });
    }
}