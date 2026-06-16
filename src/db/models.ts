export interface Message {
  seq: number;
  time: string;
  talker: string;
  sender: string;
  senderAvatar?: string;
  isSelf: boolean;
  isChatRoom: boolean;
  type: number;
  content: string;
  mediaPath?: string;
  emojiUrl?: string;
  appType?: number;
  appUrl?: string;
  appThumbUrl?: string;
  appDescription?: string;
  appAuthor?: string;
  appArticles?: AppArticle[];
  referContent?: string;
  referSender?: string;
  referSeq?: number;
  locationLabel?: string;
  locationPoiName?: string;
  voiceDuration?: number;
  voiceText?: string;
  revokedOriginal?: string;
  subMessages?: string[];
}

export interface AppArticle {
  title: string;
  description?: string;
  url?: string;
  thumbUrl?: string;
}

export interface Session {
  username: string;
  nickname: string;
  remark: string;
  alias: string;
  smallHeadUrl: string;
  bigHeadUrl: string;
  lastMessage?: string;
  lastTime?: string;
  unreadCount?: number;
  isHidden?: boolean;
  accountType?: "official" | "system" | "normal";
}

export interface Contact {
  username: string;
  alias: string;
  remark: string;
  nickname: string;
  smallHeadUrl: string;
  bigHeadUrl: string;
  localType: number;
}

export interface ChatRoom extends Contact {
  memberCount: number;
  memberList?: string[];
}

export interface DatabaseShard {
  filePath: string;
  startTime: Date;
  endTime: Date;
  talkerMap: Map<string, number>;
}
