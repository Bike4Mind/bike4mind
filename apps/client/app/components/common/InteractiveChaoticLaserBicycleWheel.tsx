import React, { useState, useEffect, useMemo, useCallback, memo } from 'react';
import { AnimatePresence, motion } from 'framer-motion';

const InteractiveChaoticLaserBicycleWheel = memo(() => {
  const [rotation, setRotation] = useState(0);
  const [hue, setHue] = useState(120); // Start with green
  const [isHovering, setIsHovering] = useState(false);

  useEffect(() => {
    const interval = setInterval(() => {
      setRotation(prev => (prev + 2) % 360);
      setHue(prev => (prev + 1) % 360);
    }, 50);

    return () => {
      clearInterval(interval);
    };
  }, []);

  const generateRandomSpoke = useCallback(() => {
    const angle = Math.random() * Math.PI * 2;
    const length = 30 + Math.random() * 60; // Random length between 30 and 90
    return {
      x2: 100 + Math.cos(angle) * length,
      y2: 100 + Math.sin(angle) * length,
      width: 1 + Math.random() * 3,
      delay: Math.random() * 0.5,
    };
  }, []);

  const spokes = useMemo(() => {
    return Array.from({ length: 15 }, generateRandomSpoke);
  }, [generateRandomSpoke]);

  const handleMouseEnter = useCallback(() => {
    setIsHovering(true);
  }, []);

  const handleMouseLeave = useCallback(() => {
    setIsHovering(false);
  }, []);

  const particles = useMemo(() => {
    return Array.from({ length: 20 }, (_, i) => ({
      angle: (i / 20) * Math.PI * 2,
      delay: i * 0.05,
    }));
  }, []);

  return (
    <div
      className="relative w-[32px] h-[32px] cursor-pointer flex items-center justify-center"
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      <svg width="32" height="32" viewBox="0 0 200 200">
        <defs>
          <filter id="glow">
            <feGaussianBlur stdDeviation="3.5" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <linearGradient id="laserGradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor={`hsl(${hue}, 100%, 50%)`} />
            <stop offset="100%" stopColor={`hsl(${(hue + 60) % 360}, 100%, 75%)`} />
          </linearGradient>
        </defs>

        {/* Outer ring */}
        <motion.circle
          cx="100"
          cy="100"
          r="90"
          fill="none"
          stroke={`hsl(${hue}, 100%, 50%)`}
          strokeWidth="4"
          filter="url(#glow)"
          initial={{ pathLength: 0, rotate: 0 }}
          animate={{ pathLength: 1, rotate: 360 }}
          transition={{ duration: 4, repeat: Infinity, ease: 'linear' }}
        />

        {/* Chaotic laser spokes */}
        {spokes.map((spoke, index) => (
          <motion.line
            key={index}
            x1="100"
            y1="100"
            x2={spoke.x2}
            y2={spoke.y2}
            stroke="url(#laserGradient)"
            strokeWidth={spoke.width}
            filter="url(#glow)"
            initial={{ pathLength: 0, opacity: 0 }}
            animate={{ pathLength: 1, opacity: [0, 1, 0] }}
            transition={{
              duration: 1.5,
              delay: spoke.delay,
              repeat: Infinity,
              repeatType: 'loop',
              ease: 'easeInOut',
            }}
          />
        ))}

        {/* Rotating center piece */}
        <motion.g animate={{ rotate: rotation }} transition={{ duration: 0.05, ease: 'linear' }}>
          <circle cx="100" cy="100" r="20" fill={`hsl(${hue}, 100%, 30%)`} filter="url(#glow)" />
          <path d="M100 85 L95 100 L105 100 Z" fill={`hsl(${(hue + 30) % 360}, 100%, 50%)`} />
        </motion.g>

        {/* Pulsating hub */}
        <motion.circle
          cx="100"
          cy="100"
          r="10"
          fill={`hsl(${hue}, 100%, 50%)`}
          filter="url(#glow)"
          animate={{
            scale: [1, 1.2, 1],
            fill: [`hsl(${hue}, 100%, 50%)`, `hsl(${(hue + 180) % 360}, 100%, 50%)`, `hsl(${hue}, 100%, 50%)`],
          }}
          transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
        />

        {/* Particle explosion on hover */}
        <AnimatePresence>
          {isHovering &&
            particles.map((particle, index) => (
              <motion.circle
                key={`particle-${index}`}
                cx="100"
                cy="100"
                r="2"
                fill={`hsl(${(hue + index * 18) % 360}, 100%, 50%)`}
                filter="url(#glow)"
                initial={{ x: 0, y: 0, opacity: 0 }}
                animate={{
                  x: Math.cos(particle.angle) * 80,
                  y: Math.sin(particle.angle) * 80,
                  opacity: [0, 1, 0],
                }}
                exit={{ x: 0, y: 0, opacity: 0 }}
                transition={{
                  duration: 1,
                  repeat: Infinity,
                  delay: particle.delay,
                }}
              />
            ))}
        </AnimatePresence>
      </svg>
    </div>
  );
});

InteractiveChaoticLaserBicycleWheel.displayName = 'InteractiveChaoticLaserBicycleWheel';

export default InteractiveChaoticLaserBicycleWheel;
