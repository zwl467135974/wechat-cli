export interface Message {
  seq: number;
  time: string;
  talker: string;
  sender: string;
  isSelf: boolean;
  isChatRoom: boolean;
  type: number;
  content: string;
  mediaPath?: string;
  mediaMd5?: string;
  emojiUrl?: string;
  appType?: number;
  appUrl?: string;
  appThumbUrl?: string;
  referContent?: string;
  referSender?: string;
  locationLabel?: string;
  locationPoiName?: string;
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
