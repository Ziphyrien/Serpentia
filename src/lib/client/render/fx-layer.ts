import { Container, Graphics } from "pixi.js";

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  age: number;
  ttl: number;
  size: number;
  color: number;
  drag: number;
}

const MAX_PARTICLES = 500;

/**
 * 特效层：单个 Graphics 重绘的轻量粒子系统
 * （吃食物反馈与死亡爆裂）。
 */
export class FxLayer {
  readonly container = new Container();
  private readonly gfx = new Graphics();
  private particles: Array<Particle> = [];

  constructor() {
    this.container.addChild(this.gfx);
  }

  burst(x: number, y: number, color: number, count = 14, speed = 260, size = 4): void {
    for (let index = 0; index < count; index += 1) {
      if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
      const angle = Math.random() * Math.PI * 2;
      const velocity = speed * (0.4 + Math.random() * 0.8);
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * velocity,
        vy: Math.sin(angle) * velocity,
        age: 0,
        ttl: 420 + Math.random() * 380,
        size: size * (0.6 + Math.random() * 0.8),
        color,
        drag: 0.86,
      });
    }
  }

  update(dtMs: number): void {
    const gfx = this.gfx;
    gfx.clear();
    if (this.particles.length === 0) return;
    const dt = dtMs / 1000;
    this.particles = this.particles.filter((particle) => {
      particle.age += dtMs;
      if (particle.age >= particle.ttl) return false;
      const drag = Math.pow(particle.drag, dt * 60);
      particle.vx *= drag;
      particle.vy *= drag;
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      const life = 1 - particle.age / particle.ttl;
      gfx.circle(particle.x, particle.y, particle.size * life).fill({
        color: particle.color,
        alpha: life * 0.9,
      });
      return true;
    });
  }

  destroy(): void {
    this.gfx.destroy();
    this.particles = [];
  }
}
