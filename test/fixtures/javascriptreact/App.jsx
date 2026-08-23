/**
 * 组件类
 */
class App extends React.Component {
  /** 状态值 */
  state = { count: 0 };

  /** 增加计数 */
  increment() {
    this.setState({ count: this.state.count + 1 });
  }

  /** 减少计数 */
  decrement() {
    this.setState({ count: this.state.count - 1 });
  }
}

/** 纯函数组件 */
function Header(props) {
  return <h1>{props.title}</h1>;
}
