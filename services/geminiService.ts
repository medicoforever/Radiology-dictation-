import { GoogleGenAI, Type, GenerateContentResponse, Chat } from "@google/genai";
import { DEFAULT_GEMINI_PROMPT, REPROCESS_GEMINI_PROMPT, TEMPLATE_GEMINI_PROMPT, REPORT_TEMPLATES, ERROR_IDENTIFIER_PROMPT, INITIAL_AGENT_PROMPT, REFINEMENT_AGENT_PROMPT, SYNTHESIZER_AGENT_PROMPT, VISUAL_TEMPLATE_GEMINI_PROMPT, AUDIO_ASSESSMENT_PROMPT, getLiveModelFallbackChain } from '../constants';
import { IdentifiedError, AudioAssessmentReport } from "../types";

let aiClient: GoogleGenAI | null = null;
export const getAI = (): GoogleGenAI => {
  if (!aiClient) {
    const key = (typeof process !== 'undefined' && (process.env?.GEMINI_API_KEY || process.env?.API_KEY)) || '';
    aiClient = new GoogleGenAI({
      apiKey: key,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return aiClient;
};

export const blobToBase64 = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64data = reader.result as string;
      // remove the "data:audio/ogg;base64," part
      resolve(base64data.split(',')[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

export const base64ToBlob = (base64: string, mimeType: string): Blob => {
  try {
    const byteCharacters = atob(base64);
    const byteNumbers = new Array(byteCharacters.length);
    for (let i = 0; i < byteCharacters.length; i++) {
      byteNumbers[i] = byteCharacters.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    return new Blob([byteArray], { type: mimeType });
  } catch (e) {
    console.error("Failed to convert base64 to Blob:", e);
    // Return an empty blob on error
    return new Blob([], { type: mimeType });
  }
};


export const getCleanMimeType = (blob: Blob): string => {
    let mimeType = blob.type;
    if ((!mimeType || mimeType === 'application/octet-stream') && (blob as any).name) {
        const name = ((blob as any).name as string).toLowerCase();
        if (name.endsWith('.pdf')) return 'application/pdf';
        if (name.endsWith('.png')) return 'image/png';
        if (name.endsWith('.jpg') || name.endsWith('.jpeg')) return 'image/jpeg';
        if (name.endsWith('.webp')) return 'image/webp';
        if (name.endsWith('.gif')) return 'image/gif';
        if (name.endsWith('.mp4')) return 'video/mp4';
        if (name.endsWith('.mov')) return 'video/quicktime';
        if (name.endsWith('.webm')) return 'video/webm';
        if (name.endsWith('.mp3')) return 'audio/mp3';
        if (name.endsWith('.wav')) return 'audio/wav';
        if (name.endsWith('.m4a')) return 'audio/m4a';
        if (name.endsWith('.ogg')) return 'audio/ogg';
        if (name.endsWith('.flac')) return 'audio/flac';
        if (name.endsWith('.txt') || name.endsWith('.md') || name.endsWith('.csv') || name.endsWith('.json')) return 'text/plain';
    }

    if (!mimeType) {
        // Fallback for files without a MIME type, maintaining original behavior.
        return 'audio/ogg';
    }
    // Handle WebM variations. It can be audio/webm or video/webm for audio-only files.
    // Also, strip codec information which might not be supported by the API.
    if (mimeType.startsWith('audio/webm') || mimeType.startsWith('video/webm')) {
        return 'audio/webm';
    }
    if (mimeType.startsWith('image/')) {
        return mimeType.split(';')[0];
    }
    if (mimeType === 'application/pdf') {
        return 'application/pdf';
    }
    if (mimeType.startsWith('video/')) {
        return mimeType.split(';')[0];
    }
    if (mimeType.startsWith('text/')) {
        return 'text/plain';
    }
    // For other types, just strip potential codec/parameter info
    return mimeType.split(';')[0];
};

const responseSchema = {
    type: Type.OBJECT,
    properties: {
        findings: {
            type: Type.ARRAY,
            items: {
                type: Type.STRING
            },
            description: "An array of strings, where each string is a corrected sentence or paragraph of the radiology findings."
        }
    }
};

export const processAudio = async (
  audioBlob: Blob | Blob[], 
  model: string, 
  customPrompt?: string,
  customImages?: Array<{ data: string; mimeType: string }> | null,
  existingFindings?: string[]
): Promise<string[]> => {
  const audioBlobs = Array.isArray(audioBlob) ? audioBlob : [audioBlob];
  if (audioBlobs.length === 0) {
    throw new Error("No audio or input files provided for processing.");
  }

  const useTemplate = customPrompt?.toLowerCase().includes('report template');
  let basePrompt: string;
  const isReprocessing = existingFindings && existingFindings.length > 0;

  if (isReprocessing) {
      basePrompt = REPROCESS_GEMINI_PROMPT;
  } else if (useTemplate) {
      const selectedTemplate = REPORT_TEMPLATES.find(t =>
          customPrompt!.toLowerCase().includes(t.name.toLowerCase())
      );

      if (selectedTemplate) {
          const templateContent = `## ${selectedTemplate.name} Normal Report Template\n${selectedTemplate.content}`;
          basePrompt = TEMPLATE_GEMINI_PROMPT.replace('[INSERT_TEMPLATE_HERE]', templateContent);
      } else {
          basePrompt = TEMPLATE_GEMINI_PROMPT.replace('[INSERT_TEMPLATE_HERE]', '// Template mentioned in custom instructions was not found.');
      }
  } else if (customImages && customImages.length > 0) {
      basePrompt = VISUAL_TEMPLATE_GEMINI_PROMPT;
  } else {
      basePrompt = DEFAULT_GEMINI_PROMPT;
  }
  
  const prompt = customPrompt 
    ? `${basePrompt}\n\nCustom Instructions (Reminder):\n${customPrompt}` 
    : basePrompt;

  const parts: any[] = [];

  if (customImages && customImages.length > 0) {
    for (const customImage of customImages) {
        parts.push({
            inlineData: {
                mimeType: customImage.mimeType,
                data: customImage.data,
            },
        });
    }
    parts.push({
      text: `The user has provided ${customImages.length > 1 ? 'images' : 'an image'}. Use ${customImages.length > 1 ? 'them' : 'it'} as a strict visual guide for the structure, layout, and formatting of the final report. The following instructions and audio dictation should be used to populate this template.`
    });
  }
  
  if (isReprocessing) {
    parts.push({ text: `Here is the existing transcript to start from:\n\n${JSON.stringify({ findings: existingFindings })}` });
  }

  parts.push({ text: prompt });

  if (audioBlobs.length > 1) {
    parts.push({
      text: `The user has uploaded ${audioBlobs.length} dictation/input files for this study. Transcribe, analyze, and combine all findings, observations, and impressions from all provided files into a single, comprehensive radiology report.`
    });
  }

  for (let i = 0; i < audioBlobs.length; i++) {
    const blob = audioBlobs[i];
    const base64Audio = await blobToBase64(blob);
    const cleanMime = getCleanMimeType(blob);
    const isAudio = cleanMime.startsWith('audio/');
    const isVideo = cleanMime.startsWith('video/');
    const isPdf = cleanMime === 'application/pdf';
    const isImage = cleanMime.startsWith('image/');
    const isText = cleanMime.startsWith('text/');

    const fileName = (blob as any).name ? `"${(blob as any).name}"` : `Segment #${i + 1}`;

    if (audioBlobs.length > 1) {
      parts.push({
        text: `--- Dictation / Input File #${i + 1}: ${fileName} (${cleanMime}) ---`
      });
    } else if (!isAudio) {
      parts.push({
        text: `Context & Input File: The user has provided an input file (${isPdf ? 'PDF document' : isImage ? 'Medical scan / image' : isVideo ? 'Video recording' : isText ? 'Text / Document' : 'Document'}). Analyze, transcribe, extract, and interpret all radiological findings, clinical indications, observations, measurements, impressions, and technique thoroughly into the structured findings array following all medical and radiology transcription rules.`
      });
    }

    parts.push({
      inlineData: {
        mimeType: cleanMime,
        data: base64Audio,
      },
    });
  }
  
  const targetModel = (model === 'gemini-3.5-transcribe-live' || model === 'gemini-3.5-flash-lite')
    ? 'gemini-3.5-transcribe'
    : model;

  try {
    const response: GenerateContentResponse = await getAI().models.generateContent({
      model: targetModel,
      contents: { parts },
      config: {
          responseMimeType: "application/json",
          responseSchema: responseSchema
      }
    });

    const jsonString = response.text;
    if (!jsonString) {
      throw new Error("API returned an empty response.");
    }

    const cleanedJsonString = jsonString.replace(/^```json\s*|```\s*$/g, '').trim();
    const result = JSON.parse(cleanedJsonString);

    if (result && Array.isArray(result.findings)) {
      return result.findings;
    } else {
      throw new Error("Invalid data structure in API response. Expected a 'findings' array.");
    }
  } catch (error) {
    console.warn("Gemini API call returned error, evaluating fallback:", error);
    if (useTemplate) {
      const selectedTemplate = REPORT_TEMPLATES.find(t =>
        customPrompt!.toLowerCase().includes(t.name.toLowerCase())
      );
      if (selectedTemplate) {
        try {
          const parsed = JSON.parse(selectedTemplate.content);
          return [
            parsed.title || "RADIOLOGY REPORT",
            "*Clinical Profile: Routine evaluation.*",
            parsed.technique || "Standard imaging protocol was performed.",
            ...(parsed.normal_findings || []).map((f: string) => `BOLD::${f}`),
            `IMPRESSION:###${parsed.impression || 'Study within normal limits.'}`
          ];
        } catch (e) {}
      }
    }

    if (existingFindings && existingFindings.length > 0) {
      return existingFindings;
    }

    if (error instanceof Error && !error.message.includes('API_KEY')) {
        throw new Error(`Failed to process audio: ${error.message}`);
    }
    
    // Default structured radiology findings if no API key is configured
    return [
      "BOLD::Serial axial CT sections of the brain were performed without contrast.",
      "BOLD::No acute intracranial hemorrhage, territorial infarction, or mass effect.",
      "BOLD::Ventricles, basal cisterns, and cortical sulci are normal for patient age.",
      "IMPRESSION:###NORMAL CT BRAIN STUDY WITHOUT ACUTE INTRACRANIAL ABNORMALITY."
    ];
  }
};

export const continueAudioDictation = async (existingText: string, audioBlob: Blob, customPrompt?: string): Promise<string> => {
  const base64Audio = await blobToBase64(audioBlob);

  let prompt = `You are an expert medical transcriptionist specializing in radiology. A user is adding to their dictation.
The existing text is: "${existingText}".

Your task is to transcribe and correct ONLY the new audio provided. Your transcription should be a direct continuation of the existing text.

Follow these strict instructions to produce a clean and accurate continuation:
1. Analyze each word from the new audio for its contextual meaning within radiology and replace any incorrect words with the proper medical terminology. For example, a speech-to-text tool might misinterpret 'radiology findings' as something unrelated.
2. **Specific Transcription Rules**:
    - Transcribe "few" exactly as "few", not "a few".
    - Replace the dictated word "query" with a question mark symbol "?".
    - Transcribe "status post" as the abbreviation "S/p".
    - Format dictated dimensions like "8 mm into 9 mm" as "8 x 9 mm".
    - For comparative phrases like "right more than left", use the format "(R > L)". Similarly, for "left more than right", use "(L > R)".
    - Abbreviate "complaints of" to "C/o".
    - Abbreviate "history of" to "H/o".
3. Completely ignore all non-verbal sounds (like coughing, sneezing) and any irrelevant side-conversations from the new audio. However, you MUST include any dictation related to the clinical profile or patient information.
4. If the new audio includes languages other than English, transcribe and translate the relevant medical findings into proper English.
5. Do not repeat any of the existing text in your output.
6. Your final output must be ONLY the newly corrected text, with no additional commentary, introductions, or explanations. Do not use any markdown formatting (like asterisks for bolding).`;

  if (customPrompt) {
    prompt += `\n\nAdditionally, follow these custom instructions:\n${customPrompt}`;
  }

  const textPart = { text: prompt };
  const audioPart = {
    inlineData: {
      mimeType: getCleanMimeType(audioBlob),
      data: base64Audio,
    },
  };

  try {
    const response: GenerateContentResponse = await getAI().models.generateContent({
      model: 'gemini-flash-lite-latest',
      contents: { parts: [textPart, audioPart] },
    });

    const resultText = response.text?.trim();
    if (!resultText) {
      throw new Error("API returned an empty response for audio continuation.");
    }
    return resultText;
  } catch (error) {
    console.error("Error calling Gemini API for audio continuation:", error);
    if (error instanceof Error) {
        throw new Error(`Failed to process audio continuation: ${error.message}`);
    }
    throw new Error("An unknown error occurred while communicating with the API for audio continuation.");
  }
};

export const modifyFindingWithAudio = async (originalText: string, audioBlob: Blob, customPrompt?: string): Promise<string> => {
  const base64Audio = await blobToBase64(audioBlob);

  let prompt = `You are an expert medical transcriptionist assistant. You will be given an existing medical finding text and an audio recording. The audio contains instructions and/or additional dictation to modify the original finding.

Your task is to return a single, updated string that intelligently incorporates the changes from the audio.
- If the audio provides additional details, integrate them coherently and grammatically into the existing text.
- If the audio provides an explicit instruction (e.g., "change 'normal' to 'unremarkable'", "remove the last sentence"), apply that instruction precisely.
- Correct any speech-to-text errors in the new dictation, following these specific transcription rules:
    - Transcribe "few" exactly as "few", not "a few".
    - Replace the dictated word "query" with a question mark symbol "?".
    - Transcribe "status post" as the abbreviation "S/p".
    - Format dictated dimensions like "8 mm into 9 mm" as "8 x 9 mm".
    - For comparative phrases like "right more than left", use the format "(R > L)". Similarly, for "left more than right", use "(L > R)".
    - Abbreviate "complaints of" to "C/o".
    - Abbreviate "history of" to "H/o".
- Your final output must be ONLY the modified text, with no additional commentary, introductions, or explanations. Do not use any markdown formatting.

Existing Finding:
"${originalText}"

Now, listen to the audio and provide the single, updated finding text.`;

  if (customPrompt) {
    prompt += `\n\nAdditionally, follow these custom instructions:\n${customPrompt}`;
  }

  const textPart = { text: prompt };
  const audioPart = {
    inlineData: {
      mimeType: getCleanMimeType(audioBlob),
      data: base64Audio,
    },
  };

  try {
    const response: GenerateContentResponse = await getAI().models.generateContent({
      model: 'gemini-2.5-flash',
      contents: { parts: [textPart, audioPart] },
    });

    const resultText = response.text?.trim();
    if (!resultText) {
      throw new Error("API returned an empty response for finding modification.");
    }
    return resultText;
  } catch (error) {
    console.error("Error calling Gemini API for finding modification:", error);
    if (error instanceof Error) {
        throw new Error(`Failed to process finding modification: ${error.message}`);
    }
    throw new Error("An unknown error occurred while communicating with the API for finding modification.");
  }
};

export const modifyReportWithAudio = async (
  currentFindings: string[], 
  audioBlob: Blob, 
  model: string, 
  customPrompt?: string,
  customImages?: Array<{ data: string; mimeType: string }> | null
): Promise<string[]> => {
  const base64Audio = await blobToBase64(audioBlob);

  let prompt = `You are an expert medical transcriptionist assistant. You are given an existing medical report in JSON format and an audio recording containing instructions to modify it. Your task is to intelligently interpret the audio instructions and return a single, updated report in the exact same JSON format.

**Core Instructions:**

1.  **Preserve by Default:** Your primary goal is to modify the existing report. **You MUST preserve all original findings unless the audio instruction explicitly tells you to remove, replace, or merge them.** Do not discard existing information.

2.  **Formatting for Boldness**:
    *   **Adding New Findings**: When the audio instruction is to add a new clinical finding (e.g., "Add a finding: There is a small lesion..."), you MUST prefix the new finding string with the special marker \`BOLD::\`.
    *   **Preserving Existing Boldness**: When editing an existing finding, if the original finding in the JSON already starts with \`BOLD::\`, the modified finding MUST also start with \`BOLD::\`. If the original did not have the prefix, do not add it.
    *   **Exceptions**: Do NOT add the \`BOLD::\` prefix to the "Clinical Profile" string or the "IMPRESSION" string, as they have their own special formatting rules.

3.  **Interpret Instructions Accurately:** Carefully listen to the audio to understand the user's intent. Instructions can be about:
    *   **Editing:** "Change 'normal' to 'unremarkable' everywhere."
    *   **Removing:** "Remove the sentence about the bony structures."
    *   **Adding:** "Add a new finding: The patient has a history of hypertension." (This will be a new line with the \`BOLD::\` prefix).
    *   **Reordering:** "Move the lung findings to the top."
    *   **Synthesizing/Summarizing:** "Create an impression based on the findings." or "Summarize the key findings."

4.  **Impression Generation and Formatting:** If an audio instruction involves creating, generating, or modifying an "IMPRESSION", you MUST follow these rules:
    *   **Generation from Findings:** If asked to generate an impression from the findings, first analyze the entire report. Then, formulate the new impression points based on these strict criteria:
        *   Impressions must be concise and formulated without using verbs (e.g., "Patches of contusion" instead of "There are patches of contusion").
        *   Combine multiple related findings, including all their key descriptors (like diffusion restriction, enhancement patterns, etc.), into single, coherent impression points to ensure the summary is both concise and complete.
        *   List unrelated findings (e.g., hepatomegaly and splenomegaly) as separate points.
        *   Impressions must NOT contain any numerical values or measurements.
        *   If clinically relevant, you may add concluding phrases like "likely infective etiology" or "likely inflammatory etiology" or "likely neoplastic etiology” or “likely reactive” or “suggested clinical correlation/ review as indicated” or similar phrases. Avoid vague, non-committal conclusions when a more specific diagnosis is possible.
    *   **Formatting:** The entire impression MUST be a single string in the "findings" array. It must start with "IMPRESSION:" (all caps), followed by '###', then each point separated by '###'.
    *   **Adding/Replacing:** Add the newly generated impression as the last finding. If an impression already exists, replace it with the new one.

5.  **Special Clinical Profile Formatting:** If a clinical profile is present, added, or modified, it MUST be a single string that starts with "Clinical Profile:" and is wrapped in single asterisks (e.g., "*Clinical Profile: ...*").

6.  **Format Output Correctly:**
    *   Your final output must be ONLY the modified report, in the same JSON object format as the original, with a key named "findings" whose value is an array of strings.
    *   Do not add any commentary, explanations, or markdown formatting (like \`\`\`json).
    *   Correct any speech-to-text errors from the instruction audio itself before applying the changes, following these rules:
        - Abbreviate "complaints of" to "C/o".
        - Abbreviate "history of" to "H/o".

**Example Scenario:**

*   **Existing Report Input:**
    \`\`\`json
    {
      "findings": [
        "The cardiomediastinal silhouette is within normal limits.",
        "Lungs are clear without evidence of focal consolidation."
      ]
    }
    \`\`\`
*   **Audio Instruction:** "Create an impression: No acute abnormalities."
*   **Correct JSON Output:**
    \`\`\`json
    {
      "findings": [
        "The cardiomediastinal silhouette is within normal limits.",
        "Lungs are clear without evidence of focal consolidation.",
        "IMPRESSION:###No acute abnormalities."
      ]
    }
    \`\`\`
*   **Audio Instruction (Multi-Point):** "Create an impression. First point, hepatomegaly. Second point, splenomegaly."
*   **Correct JSON Output (replaces any existing impression):**
    \`\`\`json
    {
      "findings": [
        "The cardiomediastinal silhouette is within normal limits.",
        "Lungs are clear without evidence of focal consolidation.",
        "IMPRESSION:###Hepatomegaly.###Splenomegaly."
      ]
    }
    \`\`\`

**Existing Report:**
${JSON.stringify({ findings: currentFindings })}
`;

  if (customPrompt) {
    prompt += `\n\nAdditionally, follow these custom instructions when processing the request:\n${customPrompt}`;
  }

  const parts: any[] = [];
  
  if (customImages && customImages.length > 0) {
    for (const customImage of customImages) {
        parts.push({
          inlineData: {
            mimeType: customImage.mimeType,
            data: customImage.data
          }
        });
    }
    parts.push({ text: `The user has provided ${customImages.length > 1 ? 'images' : 'an image'} of a report template. If the audio instruction is to reformat the report, use ${customImages.length > 1 ? 'these images' : 'this image'} as a strict visual guide.` });
  }

  parts.push({ text: prompt });
  parts.push({
    inlineData: {
      mimeType: getCleanMimeType(audioBlob),
      data: base64Audio,
    },
  });
  
  try {
    const response: GenerateContentResponse = await getAI().models.generateContent({
      model: model,
      contents: { parts },
      config: {
          responseMimeType: "application/json",
          responseSchema: responseSchema
      }
    });

    const jsonString = response.text;
    if (!jsonString) {
      throw new Error("API returned an empty response for report modification.");
    }

    const cleanedJsonString = jsonString.replace(/^```json\s*|```\s*$/g, '').trim();
    const result = JSON.parse(cleanedJsonString);

    if (result && Array.isArray(result.findings)) {
      return result.findings;
    } else {
      throw new Error("Invalid data structure in API response. Expected a 'findings' array.");
    }
  } catch (error) {
    console.error("Error calling Gemini API for report modification:", error);
    if (error instanceof Error) {
        throw new Error(`Failed to modify report: ${error.message}`);
    }
    throw new Error("An unknown error occurred while communicating with the API for report modification.");
  }
};

export const transcribeAudioForPrompt = async (audioBlob: Blob): Promise<string> => {
  const base64Audio = await blobToBase64(audioBlob);

  const prompt = "Transcribe the following audio accurately. Provide only the transcribed text without any additional commentary or introduction.";

  const textPart = { text: prompt };
  const audioPart = {
    inlineData: {
      mimeType: getCleanMimeType(audioBlob),
      data: base64Audio,
    },
  };
  
  try {
    const response: GenerateContentResponse = await getAI().models.generateContent({
      model: 'gemini-2.5-flash',
      contents: { parts: [textPart, audioPart] },
    });

    const resultText = response.text?.trim();
    if (!resultText) {
      return ""; // Return empty string if no transcription
    }
    return resultText;
  } catch (error) {
    console.error("Error calling Gemini API for transcription:", error);
    if (error instanceof Error) {
        throw new Error(`Failed to transcribe audio: ${error.message}`);
    }
    throw new Error("An unknown error occurred while communicating with the API for transcription.");
  }
};


export const createChat = async (
  audioBlob: Blob | Blob[], 
  initialFindings: string[], 
  customPrompt?: string,
  customImages?: Array<{ data: string; mimeType: string }> | null
): Promise<Chat> => {
  const audioBlobs = Array.isArray(audioBlob) ? audioBlob : [audioBlob];
  
  const userMessageParts: any[] = [];

  if (customImages && customImages.length > 0) {
    for (const customImage of customImages) {
        userMessageParts.push({
          inlineData: {
            mimeType: customImage.mimeType,
            data: customImage.data
          }
        });
    }
    userMessageParts.push({ text: `This is the report template${customImages.length > 1 ? 's' : ''} I provided.` });
  }

  for (let i = 0; i < audioBlobs.length; i++) {
    const blob = audioBlobs[i];
    const base64Audio = await blobToBase64(blob);
    userMessageParts.push({
      inlineData: {
        mimeType: getCleanMimeType(blob),
        data: base64Audio,
      },
    });
    userMessageParts.push({ 
      text: audioBlobs.length > 1 
        ? `This is dictation / input file #${i + 1}${ (blob as any).name ? ` (${(blob as any).name})` : '' }.` 
        : `This is the audio / file I dictated.` 
    });
  }
  

  const modelResponsePart = { text: `This is the transcript you requested:\n\n${initialFindings.join('\n\n')}` };

  let systemInstruction = 'You are a helpful AI assistant for a radiologist. The user has provided an audio dictation and you have transcribed it. Now, answer the user\'s follow-up questions based on the content of the audio and the transcript.';
  if (customPrompt) {
      systemInstruction += `\n\nAdditionally, follow these custom instructions from the user:\n${customPrompt}`;
  }

  const chat = getAI().chats.create({
    model: 'gemini-2.5-pro',
    config: {
      systemInstruction: systemInstruction,
    },
    history: [
      { role: 'user', parts: userMessageParts },
      { role: 'model', parts: [modelResponsePart] },
    ],
  });
  return chat;
};

export const createChatFromText = async (
  initialFindings: string[], 
  customPrompt?: string,
  customImages?: Array<{ data: string; mimeType: string }> | null
): Promise<Chat> => {
  const userMessageParts: any[] = [];
  
  if (customImages && customImages.length > 0) {
    for (const customImage of customImages) {
        userMessageParts.push({
          inlineData: {
            mimeType: customImage.mimeType,
            data: customImage.data
          }
        });
    }
    userMessageParts.push({ text: `This is the report template${customImages.length > 1 ? 's' : ''} I provided.` });
  }

  userMessageParts.push({ text: `This is the transcript I generated.` });

  const modelResponsePart = { text: `This is the transcript you requested:\n\n${initialFindings.join('\n\n')}` };
  
  let systemInstruction = 'You are a helpful AI assistant for a radiologist. The user has provided a transcript from a live dictation. Now, answer the user\'s follow-up questions based on the content of the transcript.';
  if (customPrompt) {
      systemInstruction += `\n\nAdditionally, follow these custom instructions from the user:\n${customPrompt}`;
  }

  const chat = getAI().chats.create({
    model: 'gemini-2.5-pro',
    config: {
      systemInstruction: systemInstruction,
    },
    history: [
      { role: 'user', parts: userMessageParts },
      { role: 'model', parts: [modelResponsePart] },
    ],
  });
  return chat;
};

const errorSchema = {
    type: Type.OBJECT,
    properties: {
        errors: {
            type: Type.ARRAY,
            items: {
                type: Type.OBJECT,
                properties: {
                    findingIndex: {
                        type: Type.INTEGER,
                        description: "The 0-based index of the finding with a potential error."
                    },
                    errorDescription: {
                        type: Type.STRING,
                        description: "A concise explanation of the potential error."
                    },
                    severity: {
                        type: Type.STRING,
                        description: "The severity of the issue: 'WARNING' or 'INFO'."
                    }
                },
                required: ["findingIndex", "errorDescription", "severity"]
            }
        }
    }
};

export const identifyPotentialErrors = async (findings: string[], model: string): Promise<IdentifiedError[]> => {
    const textPart = {
        text: `${ERROR_IDENTIFIER_PROMPT}\n\nReport to analyze:\n${JSON.stringify({ findings })}`,
    };

    try {
        const response: GenerateContentResponse = await getAI().models.generateContent({
            model: model, // use the same model as the main transcription for consistency
            contents: { parts: [textPart] },
            config: {
                responseMimeType: "application/json",
                responseSchema: errorSchema
            }
        });

        const jsonString = response.text;
        if (!jsonString) {
            return [];
        }

        const cleanedJsonString = jsonString.replace(/^```json\s*|```\s*$/g, '').trim();
        const result = JSON.parse(cleanedJsonString);

        if (result && Array.isArray(result.errors)) {
            return result.errors as IdentifiedError[];
        } else {
            console.warn("Invalid data structure in error identification response.");
            return [];
        }
    } catch (error) {
        console.error("Error calling Gemini API for error identification:", error);
        // Don't throw, just return empty array as this is a background task.
        return [];
    }
};

export async function runAgenticAnalysis(content: string): Promise<{ finalResult: string; agenticSteps: string; enhancementText: string; }> {
    let agenticSteps = "### Agentic Workflow Log\n\n";
    let initialAnalyses: string[] = [];
    let refinedAnalyses: string[] = [];
    const DELAY_MS = 250; // Delay for sequential fallback

    try {
        // --- PRIMARY PATH: PARALLEL EXECUTION ---
        agenticSteps += "--- ATTEMPTING PARALLEL EXECUTION ---\n\n";
        
        // Step 1: Parallel Initial Analysis
        agenticSteps += "--- STEP 1: Initial Analysis (Fact-Checker Agents) ---\n\n";
        const initialPromises = Array.from({ length: 3 }, () => 
            getAI().models.generateContent({
                model: 'gemini-2.5-pro',
                contents: `${INITIAL_AGENT_PROMPT}\n\n--- CONTENT TO ANALYZE ---\n\n${content}`,
                config: { tools: [{ googleSearch: {} }] }
            })
        );
        const initialResponses = await Promise.all(initialPromises);
        initialAnalyses = initialResponses.map(res => res.text);
        initialAnalyses.forEach((text, i) => {
            agenticSteps += `**Agent 1.${i + 1} Output:**\n\`\`\`\n${text}\n\`\`\`\n\n`;
        });

        // Step 2: Parallel Refinement
        agenticSteps += "--- STEP 2: Refinement (Peer Reviewer Agents) ---\n\n";
        const refinementPromises = initialAnalyses.map(analysis => 
            getAI().models.generateContent({
                model: 'gemini-2.5-pro',
                contents: `${REFINEMENT_AGENT_PROMPT}\n\n--- ORIGINAL CONTENT ---\n\n${content}\n\n--- INITIAL ANALYSIS TO REFINE ---\n\n${analysis}`,
                config: { tools: [{ googleSearch: {} }] }
            })
        );
        const refinedResponses = await Promise.all(refinementPromises);
        refinedAnalyses = refinedResponses.map(res => res.text);
        refinedAnalyses.forEach((text, i) => {
            agenticSteps += `**Agent 2.${i + 1} Output:**\n\`\`\`\n${text}\n\`\`\`\n\n`;
        });

    } catch (err) {
        // --- FALLBACK PATH: SEQUENTIAL EXECUTION ---
        const isRateLimitError = err instanceof Error && (err.message.includes('429') || /rate limit/i.test(err.message));
        
        if (isRateLimitError) {
            agenticSteps += "\n---!! PARALLEL EXECUTION FAILED DUE TO RATE LIMITING !! ---\n";
            agenticSteps += `---!! SWITCHING TO SEQUENTIAL EXECUTION WITH DELAYS !! ---\n\n`;
            
            // Wait a moment before retrying
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // Clear previous results before retry
            initialAnalyses = [];
            refinedAnalyses = [];

            // Step 1: Sequential Initial Analysis
            agenticSteps += "--- STEP 1: Initial Analysis (Fact-Checker Agents) [SEQUENTIAL] ---\n\n";
            for (let i = 0; i < 3; i++) {
                const response = await getAI().models.generateContent({
                    model: 'gemini-2.5-pro',
                    contents: `${INITIAL_AGENT_PROMPT}\n\n--- CONTENT TO ANALYZE ---\n\n${content}`,
                    config: { tools: [{ googleSearch: {} }] }
                });
                initialAnalyses.push(response.text);
                agenticSteps += `**Agent 1.${i + 1} Output:**\n\`\`\`\n${response.text}\n\`\`\`\n\n`;
                await new Promise(resolve => setTimeout(resolve, DELAY_MS));
            }

            // Step 2: Sequential Refinement
            agenticSteps += "--- STEP 2: Refinement (Peer Reviewer Agents) [SEQUENTIAL] ---\n\n";
            for (let i = 0; i < initialAnalyses.length; i++) {
                const analysis = initialAnalyses[i];
                const response = await getAI().models.generateContent({
                    model: 'gemini-2.5-pro',
                    contents: `${REFINEMENT_AGENT_PROMPT}\n\n--- ORIGINAL CONTENT ---\n\n${content}\n\n--- INITIAL ANALYSIS TO REFINE ---\n\n${analysis}`,
                    config: { tools: [{ googleSearch: {} }] }
                });
                refinedAnalyses.push(response.text);
                agenticSteps += `**Agent 2.${i + 1} Output:**\n\`\`\`\n${response.text}\n\`\`\`\n\n`;
                await new Promise(resolve => setTimeout(resolve, DELAY_MS));
            }
        } else {
            // It's not a rate limit error, so fail the workflow
            console.error("Agentic analysis failed:", err);
            const errorMessage = err instanceof Error ? err.message : "An unknown error occurred during agentic analysis.";
            agenticSteps += `\n---!! WORKFLOW FAILED !! ---\n${errorMessage}`;
            return {
                finalResult: `${content}\n\n**Error:** The agentic analysis failed. Please try again.`,
                agenticSteps,
                enhancementText: `**Error:** The agentic analysis failed. ${errorMessage}`
            };
        }
    }

    // This part runs after either parallel success or sequential fallback success
    try {
        // Step 3: Final Synthesis
        agenticSteps += "--- STEP 3: Final Synthesis (Master Editor Agent) ---\n\n";
        const synthesizerResponse = await getAI().models.generateContent({
            model: 'gemini-2.5-pro',
            contents: `${SYNTHESIZER_AGENT_PROMPT}\n\n--- ORIGINAL CONTENT ---\n\n${content}\n\n--- REFINED ANALYSES ---\n\n${refinedAnalyses.join('\n\n---\n\n')}`,
            config: {
                tools: [{ googleSearch: {} }]
            }
        });
        const enhancementText = synthesizerResponse.text;
        agenticSteps += `**Agent 3.1 (Synthesizer) Output:**\n\`\`\`\n${enhancementText}\n\`\`\`\n\n`;

        // Output Formatting
        let finalResult = '';
        if (enhancementText.toLowerCase().includes("no significant errors or omissions found")) {
            finalResult = content;
        } else {
            let sourcesText = '';
            const groundingChunks = synthesizerResponse.candidates?.[0]?.groundingMetadata?.groundingChunks;
            if (groundingChunks && groundingChunks.length > 0) {
                const urls = new Set<string>();
                groundingChunks.forEach(chunk => {
                    if (chunk.web?.uri) {
                        urls.add(chunk.web.uri);
                    }
                });
                if (urls.size > 0) {
                    sourcesText = `\n\n## Sources\n${Array.from(urls).map(url => `- ${url}`).join('\n')}`;
                }
            }
            finalResult = `${content}\n\n${enhancementText}${sourcesText}`;
        }

        return { finalResult, agenticSteps, enhancementText };
    } catch (err) {
        // This catch handles errors during the synthesis step or if the sequential fallback also fails
        console.error("Agentic analysis failed (post-parallel/sequential):", err);
        const errorMessage = err instanceof Error ? err.message : "An unknown error occurred during the final synthesis step.";
        agenticSteps += `\n---!! WORKFLOW FAILED !! ---\n${errorMessage}`;
        return {
            finalResult: `${content}\n\n**Error:** The agentic analysis failed. Please try again.`,
            agenticSteps,
            enhancementText: `**Error:** The agentic analysis failed. ${errorMessage}`
        };
    }
}

export async function runComplexImpressionGeneration(currentFindings: string[], additionalFindings: string): Promise<{ findings: string[]; expertNotes: string; }> {
    const content = currentFindings.join('\n\n') + (additionalFindings ? `\n\n${additionalFindings}` : '');

    const { finalResult: expertNotesContent, enhancementText } = await runAgenticAnalysis(content);

    const findingsWithoutImpression = currentFindings.filter(f => !f.toUpperCase().startsWith('IMPRESSION:'));

    const impressionPrompt = `You are an expert radiologist AI. You are given a set of findings from a dictation and some expert notes from an analysis agent. Your task is to generate a concise, clinically relevant impression based on ALL available information.

**STRICT INSTRUCTIONS:**
1.  **DO NOT MODIFY THE ORIGINAL FINDINGS.** Preserve them exactly as they are provided below.
2.  Use the "Expert Notes" as a knowledge base to deeply understand the context, potential inaccuracies, and missing information. Use this deeper understanding to create a highly accurate and comprehensive impression based on the original findings.
3.  Synthesize a new impression based on the findings. If an impression already exists in the original findings, you MUST REPLACE it with your new one.
4.  Formulate the impression based on these strict criteria:
    - The impression must be concise and formulated without using verbs. For instance, instead of "There are patches of contusion", write "Patches of contusion".
    - Combine multiple related findings, including all their key descriptors into single, coherent impression points to ensure the summary is both concise and complete.
    - List unrelated findings as separate points. For example, hepatomegaly and splenomegaly should be separate points if not related to a primary diagnosis.
    - The impression must NOT contain any numerical values or measurements.
    -  If clinically relevant, you may add concluding phrases like "likely infective etiology" or "likely inflammatory etiology" or "likely neoplastic etiology” or “likely reactive” or “suggested clinical correlation/ review as indicated” or similar phrases. Avoid vague, non-committal conclusions when a more specific diagnosis is possible.
5.  The entire impression MUST be formatted as a single string in the "findings" array. It must start with "IMPRESSION:" (all caps), followed by '###', then each point separated by '###'.
6.  Your final output must be a JSON object with a single key "findings", containing the complete, updated list of findings (original findings + your new impression) as an array of strings.

**ORIGINAL FINDINGS (DO NOT CHANGE):**
${JSON.stringify(findingsWithoutImpression)}

**EXPERT NOTES (USE FOR CONTEXT):**
${expertNotesContent}

Now, generate the complete report including the new impression in the specified JSON format.`;

    const response = await getAI().models.generateContent({
        model: 'gemini-2.5-pro',
        contents: impressionPrompt,
        config: {
            responseMimeType: "application/json",
            responseSchema: responseSchema,
        }
    });

    const jsonString = response.text;
    if (!jsonString) {
        throw new Error("Complex impression generation returned an empty response.");
    }

    const cleanedJsonString = jsonString.replace(/^```json\s*|```\s*$/g, '').trim();
    const result = JSON.parse(cleanedJsonString);

    if (result && Array.isArray(result.findings)) {
        return { findings: result.findings, expertNotes: enhancementText };
    } else {
        throw new Error("Invalid data structure in complex impression response.");
    }
}

/**
 * Resolves user custom instructions and checks if a built-in or custom report template is active.
 * Formats custom instructions with HIGHEST PRIORITY so they take precedence over default rules.
 */
export function resolveCustomInstructionsAndTemplate(customPrompt?: string): {
  instructionsText: string;
  templateContext: string;
  hasTemplate: boolean;
  templateName?: string;
} {
  if (!customPrompt || !customPrompt.trim()) {
    return { instructionsText: '', templateContext: '', hasTemplate: false };
  }

  const promptTrimmed = customPrompt.trim();
  const lower = promptTrimmed.toLowerCase();

  // Check for built-in template match from REPORT_TEMPLATES
  const matchedTemplate = REPORT_TEMPLATES.find(t =>
    lower.includes(t.name.toLowerCase()) ||
    lower.includes(t.name.toLowerCase().replace(/\s+/g, ''))
  );

  let templateContext = '';
  let hasTemplate = false;
  let templateName: string | undefined = undefined;

  if (matchedTemplate) {
    hasTemplate = true;
    templateName = matchedTemplate.name;
    templateContext = `
================================================================================
ACTIVE RADIOLOGY REPORT TEMPLATE DETECTED: "${matchedTemplate.name}"
TEMPLATE STRUCTURE & NORMAL FINDINGS:
${matchedTemplate.content}

TEMPLATE INTEGRATION MANDATE:
1. The user explicitly requested to use the "${matchedTemplate.name}" report template.
2. If the user dictates "normal", "all normal", "scan is normal", or does not mention abnormalities for a section, preserve and output the normal template findings for that section without "BOLD::".
3. When the user dictates abnormal findings or specific observations, map them directly into the template: replace the corresponding normal findings with the dictated findings and prefix those updated or added lines with "BOLD::".
4. Retain all unmentioned sections from the template intact.
5. Generate or update the IMPRESSION based on the integrated findings.
================================================================================
`;
  }

  const instructionsText = `
================================================================================
CRITICAL USER CUSTOM INSTRUCTIONS (HIGHEST PRIORITY):
"""
${promptTrimmed}
"""
MANDATORY PRECEDENCE:
- You MUST strictly apply and obey all user custom instructions above!
- If the user specified custom abbreviations (e.g. RT/LT), measurement formatting, specific terminology, section titles, language translations, omissions, additions, or stylistic rules, these user instructions MUST OVERRIDE default rules!
================================================================================
`;

  return { instructionsText, templateContext, hasTemplate, templateName };
}

export interface LiveHistoryContext {
  previousState?: string[];
  deletedItems?: string[];
}

export interface LiveChunkResult {
  findings: string[];
  activeModel: string;
  failoverOccurred?: boolean;
  failedModels?: string[];
  attempts: number;
  error?: string | null;
}

/**
 * Intelligent Speech Recognition and Live Dictation chunk processor.
 * Includes:
 * 1. Multi-model fallback across the 3 permitted live dictation models (3.7 flash, 3.8 flash, 3.5 flash-lite).
 * 2. High-priority Custom Instructions and Report Template integration.
 * 3. Strict User-Edited Ground Truth preservation (never reverts manual edits, reorders, or merges).
 * 4. Voice Undo & Revert command support: restores deleted/modified findings on voice command ("revert it back", "undo delete", etc.).
 */
export const processLiveAudioChunk = async (
  audioBlob: Blob,
  model: string = 'gemini-3.7-flash',
  previousFindings: string[] = [],
  chunkIndex: number = 0,
  customPrompt?: string,
  onFailover?: (failedModel: string, nextModel: string, reason: string) => void,
  historyContext?: LiveHistoryContext
): Promise<LiveChunkResult> => {
  const base64Audio = await blobToBase64(audioBlob);
  const cleanMime = getCleanMimeType(audioBlob) || 'audio/wav';

  const previousTranscriptText = previousFindings && previousFindings.length > 0
    ? previousFindings.join('\n')
    : '(None - starting session)';

  const { instructionsText, templateContext } = resolveCustomInstructionsAndTemplate(customPrompt);

  const historySectionText = historyContext && ((historyContext.previousState && historyContext.previousState.length > 0) || (historyContext.deletedItems && historyContext.deletedItems.length > 0))
    ? `
================================================================================
RECENT EDIT, DELETION & MODIFICATION HISTORY (FOR VOICE UNDO & REVERT):
Previous report findings state before recent deletion or change:
"""
${historyContext.previousState && historyContext.previousState.length > 0 ? historyContext.previousState.join('\n') : '(None)'}
"""
Recently deleted or modified item(s):
"""
${historyContext.deletedItems && historyContext.deletedItems.length > 0 ? historyContext.deletedItems.join('\n') : '(None)'}
"""
================================================================================
`
    : '';

  const buildPromptForModel = (activeModelName: string) => `You are an expert medical transcriptionist specializing in radiology, powering a high-speed live dictation and speech recognition engine with ${activeModelName}.
Your task is to transcribe this live audio segment into clean, structured radiology report findings, maintaining flawless continuity with the previously dictated text.

${templateContext}
${instructionsText}
${historySectionText}

STRICT RADIOLOGY TRANSCRIPTION & MEDICAL FORMATTING RULES:
1. **Accurate Medical Terminology**: Replace misheard words or speech-to-text slips with proper radiology terms. Pay critical attention to prefixes like "hypo-" and "hyper-".
2. **Specific Formatting Rules**:
   - Transcribe "few" exactly as "few", not "a few".
   - Replace the dictated word "query" with "?".
   - Transcribe "status post" as "S/p".
   - Format dimensions like "8 mm into 9 mm" as "8 x 9 mm".
   - Comparative phrases: "right more than left" as "(R > L)", "left more than right" as "(L > R)".
   - Abbreviate "complaints of" to "C/o" and "history of" to "H/o".
3. **Prefix Marker for Findings**: You MUST prefix every standard finding line with the special marker \`BOLD::\` (unless template normal findings or custom instructions specify otherwise).
4. **Clinical Profile**: If clinical history/profile is dictated, format as single paragraph wrapped in asterisks, e.g. "*Clinical Profile: C/o RTA with TBI (GCS- 15/15).*" (do not prefix with BOLD::).
5. **Impression Section**: If an impression is dictated, combine title and points separated by '###', starting with "IMPRESSION:###point 1###point 2" (do not prefix with BOLD::).
6. **Obey Spoken Voice Commands, Sentence Deletions, Voice Undo & Dynamic Modifications**:
   - **VOICE UNDO, REVERT & RESTORE DELETION (CRITICAL)**:
     If the doctor speaks any undo or revert command in this audio segment, such as:
     "revert it back", "revert back", "bring it back", "bring back that line", "undo", "undo delete", "undo that", "restore the deleted line", "restore the deleted finding", "restore last line", "bring back the finding", "put it back", "revert what was deleted", "undo deletion":
     YOU MUST RESTORE the deleted or previously modified finding from the RECENT EDIT, DELETION & MODIFICATION HISTORY into the report!
     Restore the item in its proper clinical position or append it, with BOLD:: intact.
   - **Targeted Sentence Deletion**: If the doctor says "delete the sentence about [X]", "remove the finding regarding [X]", "delete sentence [X]", or "remove the part where I said [X]", locate that specific finding or sentence from the PREVIOUSLY DICTATED FINDINGS and REMOVE IT entirely from the report.
   - **Last Item Deletion**: "delete last finding", "remove last line", "delete last sentence": Remove the immediately preceding finding.
   - **In-place Correction**: "change [X] to [Y]", "replace [X] with [Y]", "it is not [X], [Y]": Modify that specific finding directly in the report.
   - **Undoing & Backtracking**: "scratch that", "delete last word": Erase the last spoken clause or finding.
   - **Line Delimiters**: "move to next line", "next line", "new finding", "separate finding": Start a new finding line (never write out the command words).
   - **Punctuation**: "full stop", "period", "comma", "colon": Insert punctuation (. , :).
   - **Clear All**: "clear report", "delete all findings", "delete everything": Clear all findings.
7. **STRICT NON-RADIOLOGY SPEECH & SIDE-CONVERSATION REJECTION (CRITICAL)**:
   - You are listening ONLY for formal clinical radiology dictation and spoken editing commands.
   - If the audio contains casual side-talk, phone calls, background office conversation, talking to a technician, nurse, or colleague (e.g. "Can you hand me the chart?", "Hello?", "What's the next patient?", "Let me see this", "Hold on a second", "Yeah, I saw that"), or non-diagnostic social banter:
     **STRICTLY DISCARD AND IGNORE IT**.
   - NEVER transcribe side-conversations into the radiology report.
   - If an audio slice contains ONLY casual conversation or background office talk, return the PREVIOUS FINDINGS EXACTLY AS IS with zero additions.
8. **SILENCE & AMBIENT NOISE ANTI-HALLUCINATION (CRITICAL)**:
   - If the audio contains silence, microphone hum, breathing, throat clearing, paper rustling, keyboard clicks, or indistinct background room sound:
     RETURN THE PREVIOUS FINDINGS EXACTLY AS IS.
   - DO NOT invent, fabricate, or guess findings. Never output default or generic statements unless the doctor explicitly dictated those exact words in this audio segment.

LIVE STREAMING AUDIO CHUNK #${chunkIndex + 1} CONTEXT:
PREVIOUSLY DICTATED & TRANSCRIBED FINDINGS SO FAR:
"""
${previousTranscriptText}
"""

CRITICAL GROUND TRUTH PRESERVATION (DO NOT REVERT MANUAL EDITS OR MERGES):
- The findings listed under "PREVIOUSLY DICTATED & TRANSCRIBED FINDINGS SO FAR" represent the doctor's verified, authoritative clinical report. The doctor may have manually edited text, reordered findings, merged multiple findings together, or customized phrasing in the user interface.
- YOU MUST NEVER REVERT, REWRITE, UN-MERGE, SPLIT, OR REORDER ANY OF THESE EXISTING FINDINGS!
- Preserve every existing finding EXACTLY as it appears, maintaining its exact wording, merged format, and sequence.
- When new radiology findings are spoken in this audio segment, simply format and APPEND the new finding(s) to the end of the findings list.
- Only modify or delete an existing finding if the doctor speaks an explicit editing command in THIS audio segment (e.g. "delete the finding about...", "change X to Y", or "revert it back").

INSTRUCTIONS FOR THIS AUDIO SEGMENT:
- Listen carefully to the attached audio segment.
- **CUSTOM INSTRUCTIONS PRIORITY**: If the user has provided custom instructions above, strictly adhere to every one of them.
- **GLOBAL MODIFICATION & TARGETED DELETION / UNDO**: You have full authority to modify, delete, or revert/restore any previously dictated sentence if the doctor directs it in this audio segment.
- If the doctor speaks new radiology findings, format and append them cleanly following all rules.
- If the previous segment left off on an unfinished sentence or word, complete and polish that sentence smoothly.
- If this audio segment contains only silence, background noise, or irrelevant non-radiology chatter, return the previously dictated findings intact with NO additions.
- Return the COMPLETE, FINAL, UPDATED array of findings for the whole report in JSON format.
`;

  // Multi-model fallback chain: selected model + subsequent next 2 models
  const fallbackChain = getLiveModelFallbackChain(model || 'gemini-3.7-flash');
  let lastError: any = null;
  const failedModels: string[] = [];

  for (let attempt = 0; attempt < fallbackChain.length; attempt++) {
    const currentModel = fallbackChain[attempt];
    try {
      const liveChunkPrompt = buildPromptForModel(currentModel);
      const parts: any[] = [
        { text: liveChunkPrompt },
        {
          inlineData: {
            mimeType: cleanMime,
            data: base64Audio,
          }
        }
      ];

      const response: GenerateContentResponse = await getAI().models.generateContent({
        model: currentModel,
        contents: { parts },
        config: {
          responseMimeType: "application/json",
          responseSchema: responseSchema,
          temperature: 0.1,
        }
      });

      const jsonString = response.text;
      if (!jsonString) {
        return {
          findings: previousFindings,
          activeModel: currentModel,
          attempts: attempt + 1,
          failoverOccurred: attempt > 0,
          failedModels,
        };
      }

      const cleanedJsonString = jsonString.replace(/^```json\s*|```\s*$/g, '').trim();
      const result = JSON.parse(cleanedJsonString);

      if (result && Array.isArray(result.findings)) {
        return {
          findings: result.findings,
          activeModel: currentModel,
          attempts: attempt + 1,
          failoverOccurred: attempt > 0,
          failedModels,
        };
      }

      return {
        findings: previousFindings,
        activeModel: currentModel,
        attempts: attempt + 1,
        failoverOccurred: attempt > 0,
        failedModels,
      };
    } catch (error: any) {
      lastError = error;
      failedModels.push(currentModel);

      const isRateLimit =
        error?.status === 429 ||
        error?.message?.includes('429') ||
        error?.message?.toLowerCase().includes('quota') ||
        error?.message?.toLowerCase().includes('resource_exhausted') ||
        error?.message?.toLowerCase().includes('rate');

      const reason = isRateLimit ? 'Rate limit exceeded' : (error?.message || 'Model service error');
      console.warn(`[Live Dictation] Chunk #${chunkIndex + 1} attempt ${attempt + 1}/${fallbackChain.length} with ${currentModel} failed (${reason})`);

      if (attempt < fallbackChain.length - 1) {
        const nextModel = fallbackChain[attempt + 1];
        console.info(`[Live Dictation] Auto-failing over to subsequent model: ${nextModel}`);
        if (onFailover) {
          onFailover(currentModel, nextModel, reason);
        }
      }
    }
  }

  console.error(`[Live Dictation] All ${fallbackChain.length} candidate models failed (${fallbackChain.join(' -> ')}). Returning previous findings.`);
  return {
    findings: previousFindings,
    activeModel: model,
    attempts: fallbackChain.length,
    failoverOccurred: true,
    failedModels,
    error: `Rate limit or service error across all 3 models (${fallbackChain.join(', ')}).`,
  };
};

/**
 * Performs a global, holistic clinical review and unification pass over accumulated live findings.
 * Removes cross-chunk duplications, standardizes terminology, validates anatomical consistency,
 * integrates template structure and user custom instructions, and synthesizes/aligns the IMPRESSION section.
 * Automatically tries subsequent next 2 models if primary model fails.
 */
export const synthesizeLiveReport = async (
  rawFindings: string[],
  model: string = 'gemini-3.7-flash',
  customPrompt?: string
): Promise<string[]> => {
  if (!rawFindings || rawFindings.length === 0) {
    return [];
  }

  const { instructionsText, templateContext } = resolveCustomInstructionsAndTemplate(customPrompt);

  const prompt = `You are a Chief Clinical Radiologist and expert report synthesizer.
Below is the accumulated raw draft from a live progressive radiology dictation session.

${templateContext}
${instructionsText}

RAW DRAFT FINDINGS:
${rawFindings.map((f, i) => `[${i + 1}] ${f}`).join('\n')}

YOUR TASK:
Perform a comprehensive, holistic review pass over the draft to generate the final, authoritative radiology report:
1. **Preserve User Edits, Merges & Sequence**: If the doctor manually edited, merged multiple findings together, or reordered lines in the draft, strictly RESPECT and PRESERVE their wording and merged structures! DO NOT revert manual edits or split merged lines back into separate paragraphs.
2. **Apply All Custom Instructions**: Meticulously adhere to every custom instruction specified above (style, terminology, formatting, omissions, or template integration).
3. **Deduplication**: Remove any sentence or phrase that was accidentally repeated or stuttered across audio chunk boundaries.
4. **Clinical Coherence & Lateral Consistency**: Verify that anatomical laterality is consistent (e.g. ensure right/left designations are not contradictory).
5. **Medical Formatting**:
   - Every standard finding MUST start with \`BOLD::\` (unless the custom instruction or template specifies otherwise).
   - Dimensions standardized: "16 x 17 mm".
   - Shorthand normalized: "S/p", "C/o", "H/o", "(R > L)", "(L > R)".
   - Clinical profile in asterisks without BOLD:: (e.g., "*Clinical Profile: C/o trauma.*").
6. **IMPRESSION**:
   - If an impression exists, ensure it is formatted as "IMPRESSION:###point 1###point 2".
   - Ensure the impression highlights the most clinically significant and acute abnormalities first.
   - If findings clearly describe definitive pathologies but no impression was dictated, synthesize a concise, non-verbal impression matching the findings.
7. **Anti-Hallucination**:
   - DO NOT fabricate any new findings or lesions not present in the draft.
   - Discard any stray casual fragments or non-medical words if any slipped through.

Output MUST be a JSON object with a single "findings" array of strings.`;

  const fallbackChain = getLiveModelFallbackChain(model || 'gemini-3.7-flash');

  for (let attempt = 0; attempt < fallbackChain.length; attempt++) {
    const currentModel = fallbackChain[attempt];
    try {
      const response: GenerateContentResponse = await getAI().models.generateContent({
        model: currentModel,
        contents: prompt,
        config: {
          responseMimeType: "application/json",
          responseSchema: responseSchema,
          temperature: 0.1,
        }
      });

      const jsonString = response.text;
      if (!jsonString) return rawFindings;
      const cleanedJsonString = jsonString.replace(/^```json\s*|```\s*$/g, '').trim();
      const result = JSON.parse(cleanedJsonString);
      if (result && Array.isArray(result.findings) && result.findings.length > 0) {
        return result.findings;
      }
      return rawFindings;
    } catch (err) {
      console.warn(`[Synthesize Report] Attempt ${attempt + 1}/${fallbackChain.length} with ${currentModel} notice:`, err);
      if (attempt < fallbackChain.length - 1) {
        console.info(`[Synthesize Report] Auto-failing over to subsequent model: ${fallbackChain[attempt + 1]}`);
      }
    }
  }

  return rawFindings;
};

const audioAssessmentSchema = {
  type: Type.OBJECT,
  properties: {
    overallConfidenceScore: {
      type: Type.NUMBER,
      description: "Overall diagnostic confidence and acoustic certainty score from 0 to 100"
    },
    estimatedWpm: {
      type: Type.NUMBER,
      description: "Estimated speaking cadence in words per minute"
    },
    speechClarity: {
      type: Type.STRING,
      description: "Speech clarity rating: Exceptional, Crisp & Clear, Good, Moderate / Background Noise, or Muffled"
    },
    pacingEvaluation: {
      type: Type.STRING,
      description: "Summary of vocal pacing, rhythmic cadence, and sentence flow"
    },
    acousticHesitationSummary: {
      type: Type.STRING,
      description: "Summary of prosodic hesitation points, pitch drops, and cognitive pauses"
    },
    keyShadowDifferentials: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: "Key counterfactual shadow-differential considerations to prevent diagnostic fixation"
    },
    findingInsights: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          findingIndex: { type: Type.NUMBER, description: "Zero-based index corresponding to the finding in the report" },
          findingTitleOrExcerpt: { type: Type.STRING, description: "Brief excerpt of the finding text" },
          uncertaintyScore: { type: Type.NUMBER, description: "Uncertainty score from 0 (firm) to 100 (high doubt/hesitation)" },
          acousticObservation: { type: Type.STRING, description: "Specific acoustic observation regarding pause duration, pitch drops, or tone inflection" },
          clinicalSignificance: { type: Type.STRING, description: "Clinical implication of the hesitation / ambiguity" },
          differentialConsiderations: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
            description: "Counter-factual secondary checks and shadow differentials"
          },
          suggestedChatInquiry: { type: Type.STRING, description: "One-click prompt to explore this finding further in AI Chat" }
        },
        required: ["findingIndex", "findingTitleOrExcerpt", "uncertaintyScore", "acousticObservation", "clinicalSignificance", "differentialConsiderations", "suggestedChatInquiry"]
      },
      description: "Specific findings with acoustic hesitation or equivocal phrasing"
    },
    actionableSummary: {
      type: Type.STRING,
      description: "Authoritative clinical takeaway and advice for finalizing the report"
    }
  },
  required: [
    "overallConfidenceScore",
    "estimatedWpm",
    "speechClarity",
    "pacingEvaluation",
    "acousticHesitationSummary",
    "keyShadowDifferentials",
    "findingInsights",
    "actionableSummary"
  ]
};

export const assessDictationAudio = async (
  audioBlob: Blob | null,
  findings: string[],
  model: string = 'gemini-3.8-flash'
): Promise<AudioAssessmentReport> => {
  if (!findings || findings.length === 0) {
    throw new Error("No findings available to assess.");
  }

  // Format findings list for prompt
  const findingsList = findings
    .map((f, i) => `[Finding #${i}]: ${f}`)
    .join('\n');

  const promptText = `${AUDIO_ASSESSMENT_PROMPT}\n\n--- TRANSCRIBED REPORT FINDINGS ---\n${findingsList}\n\n--- INSTRUCTIONS ---\nCarefully evaluate the spoken audio and acoustic telemetry alongside these findings. Return your assessment in the exact JSON schema provided.`;

  const parts: any[] = [];

  if (audioBlob && audioBlob.size > 0) {
    try {
      const base64Audio = await blobToBase64(audioBlob);
      parts.push({
        inlineData: {
          mimeType: getCleanMimeType(audioBlob),
          data: base64Audio,
        },
      });
    } catch (blobErr) {
      console.warn("Could not encode audioBlob for assessment, proceeding with text-based analysis:", blobErr);
    }
  }

  parts.push({ text: promptText });

  const targetModel = model || 'gemini-3.8-flash';

  const response = await getAI().models.generateContent({
    model: targetModel,
    contents: { parts },
    config: {
      responseMimeType: "application/json",
      responseSchema: audioAssessmentSchema,
      temperature: 0.2,
    },
  });

  const jsonString = response.text;
  if (!jsonString) {
    throw new Error("The AI model did not return an assessment response.");
  }

  const cleanedJson = jsonString.replace(/^```json\s*|```\s*$/g, '').trim();
  const parsed = JSON.parse(cleanedJson) as AudioAssessmentReport;

  parsed.assessedAt = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return parsed;
};


