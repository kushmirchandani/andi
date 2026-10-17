// Judging happens Sunday morning, but the story is a Friday night. The demo routes can pin
// "now" to any time so risk signals (late night, weekend) behave like the real moment.

let pinned: Date | null = null;

export const clock = {
  now: () => (pinned ? new Date(pinned) : new Date()),
  pin: (iso: string | null) => {
    pinned = iso ? new Date(iso) : null;
  },
  isPinned: () => pinned !== null,
};
