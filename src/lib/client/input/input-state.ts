/**
 * 输入意图模型：所有输入设备（鼠标/键盘/摇杆）
 * 都只往这里写意图，网络发送与本地预测从这里读取。
 * 设备层与消费层互不知晓，保证低耦合。
 */
export class InputState {
  angle = 0;
  boosting = false;
  /** 是否有任何设备给出过方向（未给出时保持服务器默认方向）。 */
  hasDirection = false;
}
