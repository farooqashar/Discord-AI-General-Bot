import { extractStructured } from "../claude.js";
import { getOption, replyWithText } from "../discord.js";

const SCHEMA = {
  type: "object",
  properties: {
    question: { type: "string", description: "The trivia question" },
    correct_answer: { type: "string", description: "The correct answer, short" },
    wrong_answers: {
      type: "array",
      items: { type: "string" },
      minItems: 3,
      maxItems: 3,
      description: "Three plausible but wrong answers, similar in length and style to the correct one",
    },
    explanation: { type: "string", description: "One fun sentence explaining the answer" },
  },
  required: ["question", "correct_answer", "wrong_answers", "explanation"],
};

// Nudges Claude toward variety so repeated /trivia calls don't repeat questions.
const ANGLES = [
  "a surprising fact",
  "history",
  "science",
  "geography",
  "food and drink",
  "pop culture",
  "language and words",
  "animals and nature",
  "sports",
  "inventions and technology",
  "space",
  "art and music",
];

const LETTERS = ["🇦", "🇧", "🇨", "🇩"];

function shuffle(items) {
  const arr = [...items];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export async function trivia(interaction, env) {
  const topic = getOption(interaction, "topic");
  const angle = ANGLES[crypto.getRandomValues(new Uint32Array(1))[0] % ANGLES.length];
  const prompt = topic
    ? `Write one multiple-choice trivia question about: ${topic}. Pick a less obvious angle on it.`
    : `Write one multiple-choice trivia question about ${angle}.`;

  const q = await extractStructured(env, {
    system:
      "You write fun, accurate trivia questions of medium difficulty for a group chat. " +
      "Only use facts you're confident are correct. Avoid trick questions.",
    prompt,
    toolName: "trivia_question",
    description: "A multiple-choice trivia question",
    schema: SCHEMA,
  });

  // Shuffle in code so the right answer isn't always in the same spot.
  const choices = shuffle([q.correct_answer, ...q.wrong_answers.slice(0, 3)]);
  const correct = choices.indexOf(q.correct_answer);
  const lines = choices.map((c, i) => `${LETTERS[i]} ${c}`).join("\n");

  await replyWithText(
    env,
    interaction,
    `🧠 **Trivia${topic ? `: ${topic}` : ""}**\n\n${q.question}\n\n${lines}\n\n` +
      `Answer (click to reveal): ||${LETTERS[correct]} **${q.correct_answer}**: ${q.explanation}||`,
  );
}
