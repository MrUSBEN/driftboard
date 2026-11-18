/* Requests to open a place in a panel that may not be open yet (the command palette uses them):
   the panel takes the request when it opens, or hears the event when it is already open. */
let pendingStory: { storyId: string; shotId?: string } | null = null;
export const takeStoryGoto = () => { const g = pendingStory; pendingStory = null; return g; };
export const requestStoryGoto = (storyId: string, shotId?: string) => { pendingStory = { storyId, shotId }; window.dispatchEvent(new Event('driftboard-story-goto')); };
let pendingLib: 'trash' | null = null;
export const takeLibraryView = () => { const v = pendingLib; pendingLib = null; return v; };
export const requestLibraryView = (v: 'trash') => { pendingLib = v; window.dispatchEvent(new Event('driftboard-library-view')); };
