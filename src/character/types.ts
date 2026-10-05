export type CharacterEmotion =
  | 'idle'
  | 'happy'
  | 'excited'
  | 'focus'
  | 'surprised'
  | 'sleepy'
  | 'yawning'
  | 'thinking'
  | 'angry'
  | 'furious'
  | 'curious'
  | 'love'
  | 'dizzy'
  /** boca bem aberta esperando o arquivo cair dentro */
  | 'eager';

/** Formato dos olhos desenhado no canvas */
export type EyeStyle =
  | 'normal'
  | 'focus'
  | 'happy'
  | 'surprised'
  | 'sleepy'
  | 'angry'
  | 'curious'
  | 'heart'
  | 'spiral'
  | 'wink';

/** Animações espontâneas quando ninguém mexe no Lumo por 10 s */
export type IdleBehavior = 'wander' | 'lookAround' | 'hop' | 'stretch' | 'wiggle' | 'wink' | 'yawn' | 'glitch';

export const EYE_FOR_EMOTION: Record<CharacterEmotion, EyeStyle> = {
  idle: 'normal',
  happy: 'happy',
  excited: 'happy',
  focus: 'focus',
  surprised: 'surprised',
  sleepy: 'sleepy',
  yawning: 'sleepy',
  thinking: 'normal',
  angry: 'angry',
  furious: 'angry',
  curious: 'curious',
  love: 'heart',
  dizzy: 'spiral',
  eager: 'surprised',
};
