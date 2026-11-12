// Slash command definitions. The Worker registers these with Discord
// automatically whenever you save the Interactions Endpoint URL.
// Option types: 3 = text, 4 = whole number, 6 = user.

const DEFINITIONS = [
  {
    name: "ask",
    description: "Ask Claude anything",
    options: [
      {
        type: 3,
        name: "question",
        description: "What do you want to know?",
        required: true,
        max_length: 1500,
      },
    ],
  },
  {
    name: "tldr",
    description: "Summarize the recent conversation in this channel",
    options: [
      {
        type: 4,
        name: "messages",
        description: "How many recent messages to read (10–100, default 50)",
        min_value: 10,
        max_value: 100,
      },
    ],
  },
  {
    name: "event",
    description: "Create a server event from a plain-English description",
    options: [
      {
        type: 3,
        name: "details",
        description: 'e.g. "board game night Saturday 8pm at my place"',
        required: true,
        max_length: 500,
      },
    ],
  },
  {
    name: "remind",
    description: "Post a reminder in this channel later",
    options: [
      {
        type: 3,
        name: "reminder",
        description: 'e.g. "tomorrow at 6pm to book the restaurant"',
        required: true,
        max_length: 500,
      },
    ],
  },
  {
    name: "research",
    description: "Research a question on the web and post a report in a thread",
    options: [
      {
        type: 3,
        name: "question",
        description: "What should I research?",
        required: true,
        max_length: 500,
      },
    ],
  },
  {
    name: "eli5",
    description: "Explain anything like I'm five",
    options: [
      { type: 3, name: "topic", description: "What should I explain?", required: true, max_length: 500 },
    ],
  },
  {
    name: "decide",
    description: "Can't choose? Let the bot pick for you",
    options: [
      {
        type: 3,
        name: "options",
        description: 'Separated by commas, e.g. "pizza, sushi, tacos"',
        required: true,
        max_length: 500,
      },
    ],
  },
  {
    name: "trivia",
    description: "Get a multiple-choice trivia question",
    options: [
      { type: 3, name: "topic", description: "Optional topic, e.g. movies, NYC, space", max_length: 100 },
    ],
  },
  {
    name: "imagine",
    description: "Generate an image from a description",
    options: [
      {
        type: 3,
        name: "prompt",
        description: "Describe the image you want",
        required: true,
        max_length: 1000,
      },
    ],
  },
  {
    name: "food",
    description: "Get restaurant ideas for what you're craving",
    options: [
      { type: 3, name: "craving", description: 'e.g. "late-night ramen", "brunch"', required: true, max_length: 200 },
      { type: 3, name: "area", description: "Where? Defaults to New York City", max_length: 100 },
    ],
  },
  {
    name: "roast",
    description: "A friendly roast of someone, based on their recent messages",
    options: [{ type: 6, name: "user", description: "Who should get roasted?", required: true }],
  },
];

// Installed to servers only (not personal DMs), usable in server channels.
export const COMMANDS = DEFINITIONS.map((command) => ({
  ...command,
  integration_types: [0],
  contexts: [0],
}));
