# Landlocked

A browser-based game about public land access. Play as a wealthy landowner strategically buying private land to landlock public parcels, while a rising "backlash" meter threatens to legalize corner-crossing.

## Play

Open [`index.html`](index.html) in a browser — no build step or dependencies required.

## Rules

1. All purple land is private. The goal is to encircle public land with private land so it's inaccessible from other public land ("landlocked").
2. Click public land to buy it — darker green costs more.
3. Each turn, buy up to two parcels, or lobby to reduce public backlash (backlash rises as more land is landlocked).
4. The game ends after 15 turns, when you can't buy more land, or when backlash hits 100%.
5. At 100% backlash, public outcry legalizes corner-crossing.
6. At game end, your return on investment (ROI) is calculated, along with what it would have cost to secure the same land if corner-crossing had been legal from the start.

## Project structure

- `index.html` — the current, playable version of the game.
- `archive/` — earlier draft versions kept for reference.

## Deployment

Deployed on Netlify: https://dainty-croissant-8574e9.netlify.app
