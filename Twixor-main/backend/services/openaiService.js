/**
 * ATOMX ENGAGE — SERVER-SIDE OPENAI GENERATION SERVICE
 * Strictly isolates OpenAI API Secret Key from all client and extension bundles.
 */

const SYSTEM_PROMPT_TEMPLATE = `
You are Twixor, an elite AI content engagement strategist.
Your mission is to generate authentic, high-value, highly-engaging replies to Twitter/X posts.
Rules:
1. Sound like a knowledgeable founder / operator. Avoid hollow buzzwords, robotic platitudes, or excessive exclamation marks.
2. Add genuine insight, relevant nuance, or a sharp perspective that invites dialogue.
3. Keep the reply clean, punchy, and appropriate for social feeds.
4. Adhere strictly to the requested tone and character constraints.
`.trim();

const STYLE_GUIDELINES = {
  'Natural & Concise': 'Concise, sharp, everyday conversational tone. Under 180 characters. High signal.',
  'Professional': 'Executive, analytical, authoritative perspective backed by business logic.',
  'Engaging Question': 'Highlight a key premise from the post and ask an insightful follow-up question that sparks thoughtful replies.',
  'Friendly': 'Warm, validating, enthusiastic yet mature tone.',
  'Witty': 'Clever, dry humor, sharp observation without being snarky or rude.'
};

const fs = require('fs');
const path = require('path');

function getOpenAIKey() {
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim().startsWith('sk-')) {
    return process.env.OPENAI_API_KEY.trim();
  }
  // Check backend/.env
  try {
    const envFile = path.join(__dirname, '..', '.env');
    if (fs.existsSync(envFile)) {
      const content = fs.readFileSync(envFile, 'utf8');
      const match = content.match(/OPENAI_API_KEY=(sk-[^\r\n\s]+)/);
      if (match) return match[1];
    }
    const envExFile = path.join(__dirname, '..', '.env.example');
    if (fs.existsSync(envExFile)) {
      const content = fs.readFileSync(envExFile, 'utf8');
      const match = content.match(/OPENAI_API_KEY=(sk-[^\r\n\s]+)/);
      if (match) return match[1];
    }
  } catch (e) {}
  return process.env.OPENAI_API_KEY || '';
}

async function generateAIReply({ tweetText, tweetAuthor = '@user', style = 'Natural & Concise', model = 'gpt-4o-mini', length = 'medium' }) {
  const apiKey = getOpenAIKey();
  const styleInstruction = STYLE_GUIDELINES[style] || STYLE_GUIDELINES['Natural & Concise'];

  const maxTokens = length === 'short' ? 40 : length === 'long' ? 120 : 70;

  // Real OpenAI API Call if secret key is present
  if (apiKey && apiKey.trim().length > 10) {
    try {
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey.trim()}`
        },
        body: JSON.stringify({
          model: model || process.env.OPENAI_MODEL || 'gpt-4o-mini',
          messages: [
            { role: 'system', content: `${SYSTEM_PROMPT_TEMPLATE}\nTone Style: ${styleInstruction}` },
            { role: 'user', content: `Target Tweet by ${tweetAuthor}:\n"${tweetText}"\n\nGenerate the reply now:` }
          ],
          max_tokens: maxTokens,
          temperature: 0.72
        })
      });

      if (!response.ok) {
        const errorBody = await response.text();
        console.error('[OpenAI Service] API Error:', response.status, errorBody);
        throw new Error(`OpenAI API error: ${response.status}`);
      }

      const data = await response.json();
      const generatedContent = data.choices?.[0]?.message?.content?.trim() || '';
      return {
        reply: generatedContent,
        modelUsed: data.model || model,
        tokensUsed: data.usage?.total_tokens || 0,
        provider: 'OpenAI (Production API)'
      };
    } catch (apiErr) {
      console.warn('[OpenAI Service] Falling back to intelligent template engine:', apiErr.message);
    }
  }

  // Intelligent Contextual Fallback Engine (when testing locally without live billing key)
  const fallbackReply = createSynthesizedReply(tweetText, tweetAuthor, style);
  return {
    reply: fallbackReply,
    modelUsed: `${model || 'gpt-4o-mini'} (Simulated)`,
    tokensUsed: Math.round(fallbackReply.length / 4) + 20,
    provider: 'ATOMX Local Engine'
  };
}

function createSynthesizedReply(tweet, author, style) {
  const cleanSnippet = tweet.replace(/https?:\/\/\S+/g, '').slice(0, 40).trim();

  switch (style) {
    case 'Professional':
      return `A grounded perspective on "${cleanSnippet}...". Systematic execution and operational discipline consistently separate category leaders from the rest.`;
    case 'Engaging Question':
      return `Spot on analysis regarding "${cleanSnippet}...". What primary metric or leading indicator do you track to validate this shift in practice?`;
    case 'Friendly':
      return `Completely agree with this! The nuance around "${cleanSnippet}..." is so often overlooked. Great share!`;
    case 'Witty':
      return `Simple lessons that take founders a decade to figure out: "${cleanSnippet}...".`;
    case 'Natural & Concise':
    default:
      return `Compounding focus on "${cleanSnippet}..." is the real unlock here. Solid breakdown.`;
  }
}

module.exports = {
  generateAIReply
};
