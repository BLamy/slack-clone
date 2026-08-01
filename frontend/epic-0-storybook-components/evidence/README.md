# Storybook visual evidence

These screenshots are fixture-only visual evidence for Frontend Epic 0. They are not
Replay uploads and do not represent backend or authentication behavior.

Regenerate them with Storybook running on port 6006:

```sh
pnpm storybook
pnpm storybook:screenshots
```

The JSON manifest records the story ID, viewport, and browser console/request checks for
each capture. The current set is the review gate for the initial React Aria/shadcn
direction: light mode, dark mode, keyboard focus, desktop workspace shell, and mobile
workspace shell.
