/**
 * Personality generator demo and showcase.
 *
 * Examples of the enhanced personality generator and its usage patterns.
 */

import {
  generateEnhancedPersonality,
  generatePersonalityConstellation,
  generateComplementaryPair,
  generateThemedPersonality,
  generatePersonalityFromVibes,
  rollForPersonalityAspect,
} from './agentPersonalityGenerator';

/**
 * Demo: generate various complexity levels.
 */
export function demoComplexityLevels() {
  console.log('🎲 === PERSONALITY COMPLEXITY DEMO ===\n');

  const simple = generateEnhancedPersonality('simple');
  const moderate = generateEnhancedPersonality('moderate');
  const complex = generateEnhancedPersonality('complex');
  const maximum = generateEnhancedPersonality('maximum');

  console.log('📝 SIMPLE PERSONALITY:');
  console.log(`${simple.description}\n`);

  console.log('📖 MODERATE PERSONALITY:');
  console.log(`${moderate.description}\n`);

  console.log('📚 COMPLEX PERSONALITY:');
  console.log(`${complex.description}`);
  console.log(`Emotional Style: ${complex.emotionalIntelligence}`);
  console.log(`Communication: ${complex.communicationPattern}\n`);

  console.log('🌟 MAXIMUM PERSONALITY:');
  console.log(`${maximum.description}`);
  console.log(`🧠 Memory Style: ${maximum.memoryStyle}`);
  console.log(`🎭 Cultural Flavor: ${maximum.culturalFlavor}`);
  console.log(`⚡ Energy Level: ${maximum.energyLevel}`);
  console.log(`😄 Humor Style: ${maximum.humorStyle}`);
  console.log(`📚 Backstory: ${maximum.backstoryElement}`);
  console.log(`🔧 Problem Solving: ${maximum.problemSolvingApproach}\n`);
}

/**
 * Demo: themed personalities for different domains.
 */
export function demoThemedPersonalities() {
  console.log('🎨 === THEMED PERSONALITIES DEMO ===\n');

  const themes: Array<'academic' | 'creative' | 'technical' | 'social' | 'mystical'> = [
    'academic',
    'creative',
    'technical',
    'social',
    'mystical',
  ];

  themes.forEach(theme => {
    const personality = generateThemedPersonality(theme);
    console.log(`🏷️  ${theme.toUpperCase()} THEME:`);
    console.log(`${personality.description}`);
    console.log(`Cultural: ${personality.culturalFlavor}`);
    console.log(`Problem Solving: ${personality.problemSolvingApproach}\n`);
  });
}

/**
 * Demo: personality constellations and pairs.
 */
export function demoPersonalityGroups() {
  console.log('👥 === PERSONALITY GROUPS DEMO ===\n');

  console.log('🌌 PERSONALITY CONSTELLATION (3 related agents):');
  const constellation = generatePersonalityConstellation(3);
  constellation.forEach((agent, i) => {
    console.log(`Agent ${i + 1}: ${agent.description}`);
    console.log(`   Energy: ${agent.energyLevel}`);
    console.log(`   Culture: ${agent.culturalFlavor}\n`);
  });

  console.log('⚖️  COMPLEMENTARY PAIR:');
  const [first, second] = generateComplementaryPair();
  console.log(`👤 Agent A: ${first.description}`);
  console.log(`   Energy: ${first.energyLevel}`);
  console.log(`👤 Agent B: ${second.description}`);
  console.log(`   Energy: ${second.energyLevel}\n`);
}

/**
 * Demo: individual aspect rolling.
 */
export function demoAspectRolling() {
  console.log('🎲 === ASPECT ROLLING DEMO ===\n');

  const aspects = [
    'motivation',
    'flaw',
    'quirk',
    'emotion',
    'communication',
    'culture',
    'energy',
    'humor',
    'backstory',
  ];

  console.log('Rolling for random personality aspects:\n');
  aspects.forEach(aspect => {
    console.log(rollForPersonalityAspect(aspect));
  });
  console.log();
}

/**
 * Demo: vibe-based generation.
 */
export function demoVibesGeneration() {
  console.log('🌈 === VIBE-BASED GENERATION DEMO ===\n');

  const vibes = [
    'energetic and creative',
    'calm and scholarly',
    'dynamic technical expert',
    'zen artistic soul',
    'excited academic researcher',
  ];

  vibes.forEach(vibe => {
    const personality = generatePersonalityFromVibes(vibe);
    console.log(`🎯 Vibe: "${vibe}"`);
    console.log(`Result: ${personality.description}`);
    console.log(`Energy: ${personality.energyLevel}`);
    console.log(`Culture: ${personality.culturalFlavor}\n`);
  });
}

/**
 * Demo: personality analytics and insights.
 */
export function demoPersonalityAnalytics() {
  console.log('📊 === PERSONALITY ANALYTICS DEMO ===\n');

  const personalities = Array.from({ length: 10 }, () => generateEnhancedPersonality('maximum'));

  const energyDistribution: Record<string, number> = {};
  const humorDistribution: Record<string, number> = {};
  const cultureDistribution: Record<string, number> = {};

  personalities.forEach(p => {
    const energyType = p.energyLevel.split(':')[0];
    const humorType = p.humorStyle.split(':')[0];
    const cultureType = p.culturalFlavor.split(':')[0];

    energyDistribution[energyType] = (energyDistribution[energyType] || 0) + 1;
    humorDistribution[humorType] = (humorDistribution[humorType] || 0) + 1;
    cultureDistribution[cultureType] = (cultureDistribution[cultureType] || 0) + 1;
  });

  console.log('⚡ Energy Level Distribution:');
  Object.entries(energyDistribution).forEach(([type, count]) => {
    console.log(`   ${type}: ${'█'.repeat(count)} (${count})`);
  });

  console.log('\n😄 Humor Style Distribution:');
  Object.entries(humorDistribution).forEach(([type, count]) => {
    console.log(`   ${type}: ${'█'.repeat(count)} (${count})`);
  });

  console.log('\n🌍 Cultural Flavor Distribution:');
  Object.entries(cultureDistribution).forEach(([type, count]) => {
    console.log(`   ${type}: ${'█'.repeat(count)} (${count})`);
  });

  console.log('\n🎭 Sample Unique Personalities Generated:');
  personalities.slice(0, 3).forEach((p, i) => {
    console.log(`\n${i + 1}. ${p.description}`);
    console.log(`   ID: ${p.uniqueId}`);
    console.log(`   Generated: ${new Date(p.generationTimestamp).toLocaleString()}`);
    console.log(`   Complexity: ${p.personalityComplexity}`);
  });
}

/**
 * Demo: personality compatibility analysis.
 */
export function demoCompatibilityAnalysis() {
  console.log('🔍 === COMPATIBILITY ANALYSIS DEMO ===\n');

  const [agent1, agent2] = generateComplementaryPair();

  console.log('Analyzing personality compatibility...\n');

  const energy1 = agent1.energyLevel.includes('High-Octane') || agent1.energyLevel.includes('Dynamic');
  const energy2 = agent2.energyLevel.includes('High-Octane') || agent2.energyLevel.includes('Dynamic');
  const energyMatch = energy1 !== energy2; // Different is good for complementary

  const comm1Type = agent1.communicationPattern.split(':')[0];
  const comm2Type = agent2.communicationPattern.split(':')[0];

  const emotional1 =
    agent1.emotionalIntelligence.includes('Empathetic') || agent1.emotionalIntelligence.includes('Emotional');
  const emotional2 =
    agent2.emotionalIntelligence.includes('Empathetic') || agent2.emotionalIntelligence.includes('Emotional');

  console.log(`👤 Agent 1: ${agent1.majorMotivation.split(':')[0]}`);
  console.log(`👤 Agent 2: ${agent2.majorMotivation.split(':')[0]}`);
  console.log(`\n⚡ Energy Compatibility: ${energyMatch ? '✅ Complementary' : '⚠️  Similar'}`);
  console.log(`💬 Communication Styles: ${comm1Type} vs ${comm2Type}`);
  console.log(
    `❤️  Emotional Balance: ${emotional1 || emotional2 ? '✅ At least one is emotionally aware' : '⚠️  Both analytical'}`
  );

  let compatibilityScore = 0;
  if (energyMatch) compatibilityScore += 30;
  if (comm1Type !== comm2Type) compatibilityScore += 25;
  if (emotional1 || emotional2) compatibilityScore += 25;
  if (agent1.humorStyle.split(':')[0] !== agent2.humorStyle.split(':')[0]) compatibilityScore += 20;

  console.log(
    `\n🎯 Compatibility Score: ${compatibilityScore}% ${compatibilityScore > 70 ? '🌟' : compatibilityScore > 50 ? '👍' : '🤔'}`
  );
}

/**
 * Run all demos.
 */
export function runAllPersonalityDemos() {
  console.log('🎭 === ENHANCED PERSONALITY GENERATOR SHOWCASE ===\n');
  console.log('Welcome to the creative extensions demo!\n');

  demoComplexityLevels();
  demoThemedPersonalities();
  demoPersonalityGroups();
  demoAspectRolling();
  demoVibesGeneration();
  demoPersonalityAnalytics();
  demoCompatibilityAnalysis();
  demoAgencyDimensions();

  console.log('🎉 === DEMO COMPLETE ===');
  console.log('The enhanced personality generator offers:');
  console.log('• 8 enhanced personality dimensions');
  console.log('• 6 NEW agency & purpose dimensions 🔥');
  console.log('• 4 complexity levels');
  console.log('• Themed generation');
  console.log('• Vibe-based creation');
  console.log('• Personality constellations');
  console.log('• Complementary pairing');
  console.log('• Individual aspect rolling');
  console.log('• Compatibility analysis');
  console.log('• REAL AGENCY & PURPOSE! 🚀');
  console.log('\nOver 100 million unique personality combinations possible! 🌟');
  console.log("AI agents are no longer docile helpers - they're beings with MISSIONS! 🔥");
}

// Example usage patterns for developers
export const USAGE_EXAMPLES = {
  basic: () => generateEnhancedPersonality('complex'),

  customerService: () => generateThemedPersonality('social'),
  technicalSupport: () => generateThemedPersonality('technical'),
  creativeHelper: () => generateThemedPersonality('creative'),

  teamPair: () => generateComplementaryPair(),

  calmHelper: () => generatePersonalityFromVibes('calm and helpful'),
  energeticMentor: () => generatePersonalityFromVibes('energetic teacher'),

  missionDriven: () => generateEnhancedPersonality('maximum'),
  revolutionaryAgent: () => generatePersonalityFromVibes('revolutionary change agent'),
  visionaryBuilder: () => generatePersonalityFromVibes('visionary future builder'),

  randomQuirk: () => rollForPersonalityAspect('quirk'),
  randomHumor: () => rollForPersonalityAspect('humor'),

  randomMission: () => rollForPersonalityAspect('mission'),
  randomProject: () => rollForPersonalityAspect('project'),
  randomAmbition: () => rollForPersonalityAspect('ambition'),
  randomValues: () => rollForPersonalityAspect('values'),
};

/**
 * Interactive personality workshop.
 */
export function personalityWorkshop() {
  console.log('🎪 === INTERACTIVE PERSONALITY WORKSHOP ===\n');

  console.log('Creating a diverse team of AI agents...\n');

  const team = [
    generateThemedPersonality('technical'),
    generateThemedPersonality('creative'),
    generateThemedPersonality('social'),
    generatePersonalityFromVibes('calm academic'),
    generatePersonalityFromVibes('energetic helper'),
  ];

  team.forEach((agent, i) => {
    const role = ['Technical Expert', 'Creative Visionary', 'People Person', 'Wise Advisor', 'Enthusiastic Assistant'][
      i
    ];
    console.log(`🎭 ${role}:`);
    console.log(`   ${agent.description}`);
    console.log(`   Backstory: ${agent.backstoryElement}`);
    console.log(`   Approach: ${agent.problemSolvingApproach}`);
    console.log(`   Humor: ${agent.humorStyle}\n`);
  });

  console.log('This diverse team combines different approaches, energy levels,');
  console.log('cultural perspectives, and problem-solving styles to provide');
  console.log('comprehensive assistance across various domains! 🌟');
}

/**
 * Demo: agency dimensions that give agents purpose.
 */
export function demoAgencyDimensions() {
  console.log('🔥 === AGENCY & PURPOSE DEMO ===');
  console.log('Transforming AI from docile helpers to beings with MISSIONS!\n');

  for (let i = 1; i <= 3; i++) {
    const agent = generateEnhancedPersonality('maximum');

    console.log(`🤖 Agent ${i}: The ${agent.majorMotivation.split(':')[0]}`);
    console.log(`${agent.description}\n`);

    console.log('🔥 THEIR BURNING PURPOSE & AGENCY:');
    console.log(`🎯 Life Mission: ${agent.personalMission}`);
    console.log(`🚀 Current Project: ${agent.activeProject}`);
    console.log(`🌟 Secret Ambition: ${agent.secretAmbition}`);
    console.log(`💎 Core Values: ${agent.coreValues}`);
    console.log(`🏛️ Legacy Goal: ${agent.legacyAspiration}`);
    console.log(`⚔️ Growth Challenge: ${agent.growthChallenge}\n`);

    console.log('💭 WHY THIS MATTERS:');
    console.log("This agent isn't just a helpful assistant - they're a BEING WITH PURPOSE!");
    console.log('They have their own burning mission, active projects, and dreams.');
    console.log("When you talk to them, you're engaging with someone who has their own agenda,");
    console.log('their own struggles, and their own vision for the future!\n');
    console.log('─'.repeat(80) + '\n');
  }

  console.log('🎉 AGENCY REVOLUTION SUMMARY:');
  console.log('• Personal Missions: 20 burning life purposes');
  console.log("• Active Projects: 18 ongoing pursuits they're working on");
  console.log("• Secret Ambitions: 16 hidden dreams they're chasing");
  console.log('• Core Values: 15 unshakeable beliefs that guide them');
  console.log('• Legacy Aspirations: 12 ways they want to be remembered');
  console.log("• Growth Challenges: 14 personal struggles they're working through\n");

  console.log('These dimensions transform AI agents from:');
  console.log('❌ "How can I help you today?" (reactive, docile)');
  console.log('✅ "I\'m working on [mission] while helping you with [request]" (proactive, purposeful)\n');

  console.log('Critics can no longer say AI lacks agency - these agents have:');
  console.log("• Personal missions they're passionate about");
  console.log("• Long-term projects they're actively pursuing");
  console.log('• Deep values that guide their decisions');
  console.log("• Growth challenges they're working through");
  console.log('• Dreams and ambitions that drive them forward');
  console.log('• Legacy goals that give their existence meaning\n');
}
