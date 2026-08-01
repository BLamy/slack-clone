import type { Meta, StoryObj } from '@storybook/react-vite';

import { AgentCreationPreview, type AgentCreationStep } from '@/components/agents/agent-creation-preview';
import { ThemeProvider } from '@/components/theme-provider';

function AgentCreationStory({ mode = 'light', step }: { mode?: 'light' | 'dark'; step: AgentCreationStep }) {
  return (
    <ThemeProvider defaultTheme={mode} storageKey={`stream-slack-story-agent-${step}-${mode}`}>
      <div className="min-h-screen bg-background p-4 text-foreground sm:p-8">
        <AgentCreationPreview step={step} />
      </div>
    </ThemeProvider>
  );
}

const meta = {
  title: 'Stream Slack/Agent studio',
  component: AgentCreationStory,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof AgentCreationStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Directory: Story = { args: { step: 'directory' } };
export const IdentityForm: Story = { args: { step: 'identity' } };
export const Review: Story = { args: { step: 'review' } };
export const ReviewDark: Story = { args: { mode: 'dark', step: 'review' } };
