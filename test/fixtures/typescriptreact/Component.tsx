/**
 * 组件属性接口
 */
export interface IProps {
  /** 标题 */
  title: string;
  /** 点击回调 */
  onClick(): void;
}

/** 按钮组件 */
export class Button extends React.Component<IProps> {
  /** 组件名 */
  static displayName = "Button";

  /** 渲染 */
  render() {
    return null;
  }
}

/** 纯函数组件 */
export const App = (props: IProps) => null;
