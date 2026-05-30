import { GoogleGenAI } from '@google/genai';
import { env } from './env.js';

// Initialize and instantiate the GoogleGenAI client with the validated API Key.
// This client manages secure authentication and structure configuration for all
// communication targeting the Gemini API endpoint.
export const ai = new GoogleGenAI({ apiKey: env.GEMINI_API_KEY });

/*
=========================================
FILE: src/config/gemini.js
=========================================
DESCRIPTION:
This module initializes and exports the Google Gen AI client. It functions as the
gateway to access Gemini large language models, specifically the 'gemini-2.5-flash'
model which we use for processing client requests and executing lead extraction tools.

WORKFLOW:
1. Imports the GoogleGenAI SDK wrapper and our validated environment object 'env'.
2. Instantiates 'GoogleGenAI' with the configured GEMINI_API_KEY.
3. Exports the instanced 'ai' client object.

CONNECTION TO OTHER FILES:
- Imports configuration from src/config/env.js to retrieve the API key.
- Exported 'ai' client is imported by src/services/ai.service.js to dispatch natural language text and tool calling payloads to the Gemini API.
=========================================
*/
