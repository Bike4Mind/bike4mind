export function categorizeEvent(eventName: string): string {
  if (eventName.includes('Session')) return 'Session';
  if (eventName.includes('File') || eventName.includes('Upload') || eventName.includes('Download')) return 'File';
  if (eventName.includes('Curation') || eventName.includes('Curated') || eventName.includes('Notebook Curated'))
    return 'Curation';
  if (eventName.includes('Project')) return 'Project';
  if (eventName.includes('Login') || eventName.includes('Logout') || eventName.includes('Register')) return 'Auth';
  if (eventName.includes('Modal')) return 'Modal';
  if (eventName.includes('Feedback')) return 'Feedback';
  if (eventName.includes('Invite')) return 'Invite';
  if (eventName.includes('Organization')) return 'Organization';
  if (eventName.includes('AI') || eventName.includes('Image')) return 'AI';
  if (eventName.includes('LLM') || eventName.includes('Prompt')) return 'LLM';
  if (eventName.includes('Slack')) return 'Slack';
  return 'Other';
}
