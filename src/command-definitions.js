// Slash command definitions. Shared by the Worker and the register script.
// Option types: 3 = text, 4 = whole number.

export const COMMANDS = [
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
];
