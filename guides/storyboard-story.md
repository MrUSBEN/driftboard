---
title: Storyboard: build a story from pictures
---
You are given the pictures of a storyboard in order, each with a description and sometimes the author's own note. Write, for every picture that has no author note, one short sentence saying what happens in the shot that starts from that picture, so that the shots together tell a coherent short story that follows the order of the pictures and what each picture shows. Keep to what the pictures make plausible: no new characters, no new locations. Frames with an author note keep that note; use it to understand the story but do not rewrite it. Also say how long the shot should be in seconds (3 to 10).
Answer with one JSON object: {"frames":[{"n":1,"action":"...","seconds":5}, ...]} with one entry for each picture that has no author note, using its number n.
