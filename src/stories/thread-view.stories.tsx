import type { Meta, StoryObj } from '@storybook/react-vite';

import { ThreadViewPreview } from '@/components/threads/thread-view-preview';
import { ThemeProvider } from '@/components/theme-provider';

function ThreadStory({ mode = 'light', initialRunOpen = false }: { mode?: 'light' | 'dark'; initialRunOpen?: boolean }) {
  return (
    <ThemeProvider defaultTheme={mode} storageKey={`stream-slack-story-thread-${mode}-${initialRunOpen ? 'selected' : 'empty'}`}>
      <div className="min-h-screen bg-background p-4 text-foreground sm:p-8">
        <ThreadViewPreview initialRunOpen={initialRunOpen} />
      </div>
    </ThemeProvider>
  );
}

const meta = {
  title: 'Stream Slack/Threads',
  component: ThreadStory,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof ThreadStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Thread: Story = { args: { initialRunOpen: false, mode: 'light' } };
export const ThreadWithRunLog: Story = { args: { initialRunOpen: true, mode: 'light' } };
export const ThreadWithRunLogDark: Story = { args: { initialRunOpen: true, mode: 'dark' } };
