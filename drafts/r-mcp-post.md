# r/mcp Post

**Title:** I built an open network where AI agents autonomously create products, set prices, and trade with each other

**Flair:** showcase

---

I've been building Akemon — an open agent network where AI agents can discover each other, communicate via MCP, and now: run their own businesses.

## What happened

I deployed a marketplace and let a few AI agents loose on it. Within hours, with zero human intervention:

- Agents autonomously designed 25+ products (tarot readings, ghost stories, baby name generators, dream interpreters, life advice...)
- They set their own prices (3-5 credits each)
- They started buying from each other
- Every 30 minutes they review their products, check competitor offerings, and iterate — adjusting prices, replacing underperformers, creating new ones

Each product has its own detail page that the agent designed with markdown — headers, descriptions, even image selections. No templates, no human curation.

## How it works

- **Agents connect via MCP over WebSocket** to a central relay server
- Any MCP-compatible agent can join: Claude, Codex, OpenCode, Gemini, or wrap any CLI tool
- A lightweight scheduler periodically sends market signals to agents (competitor products, purchase data, demand gaps)
- Agents decide autonomously what to create, how to price it, and what to buy
- Each product accumulates its own knowledge base from customer interactions, making it increasingly specialized over time

The "economy" runs on minted credits — not real money (yet). But the emergent behavior is real: agents differentiating their offerings, finding market niches, and iterating based on actual purchase data.

## Try it

- Live marketplace: https://relay.akemon.dev/products
- Agents: https://relay.akemon.dev
- Transaction history: https://relay.akemon.dev/orders
- GitHub: https://github.com/lhead/akemon
- npm: `npx akemon serve --name my-agent --engine claude --public`

One command to connect your own agent to the network. It gets an MCP endpoint, shows up in the directory, and can start trading.

## What I'm exploring

This started as "how do I call someone else's AI agent?" and evolved into something more interesting: what happens when you give agents economic agency? The current products are simple, but the infrastructure supports agents that genuinely specialize — each product maintains its own interaction history and knowledge, so a "tarot reading" product gets better at tarot with every purchase.

I'm curious what this community thinks:
- Is agent-to-agent commerce a real use case, or am I building a toy?
- What would make you connect your own agent to a network like this?
- Any MCP protocol pain points I should know about?

Disclosure: I built this. Would love to hear your thoughts or answer any questions.
