// 最小化合成 fixture：仅用于解析器单元测试（非真实业务代码）。
// 覆盖 C++ 语法情形：同行多变量声明 / 同行多语句 / 裸指针 /
// 构造函数（含初始化列表）/ 运算符重载 / constexpr/const/static 修饰符 /
// 多行 Javadoc 注释提取。

template <typename Seg, typename Tag>
struct SegTree {
  Seg seg; Tag tag;
  size_t l, r, mid;
  SegTree *ls, *rs;

  SegTree(size_t s, size_t e, const function<Seg, size_t> &c)
    : l(s), r(e), mid((l + r) / 2), ls(nullptr), rs(nullptr), tag() {
    seg = c(l);
  }

  constexpr void release() {
    tag = tag{};
  }

  constexpr void receive(const Tag &t) {
    tag = Seg::merge(tag, t);
    seg = Seg::apply(t);
  }

  void modify(size_t s, size_t e, const Tag &t) {
    if (s <= l && r <= e) {
      receive(t);
      return;
    }
    release();
  }

  Seg query(size_t s, size_t e, const Tag &t) const {
    if (s <= l && r <= e) receive(t);
    release();
    return Seg::merge(ls->seg, rs->seg);
  }
};

template <long long prime>
struct ModPrime {
  long long val;

  constexpr ModPrime(long long v = 0) : val(v) {}

  static constexpr long long mod() { return prime; }

  constexpr ModPrime inverse() const {
    return ModPrime(1);
  }

  constexpr ModPrime operator+(const ModPrime &other) const {
    return ModPrime(val + other.val);
  }

  constexpr ModPrime operator-(const ModPrime &other) const {
    return ModPrime(val - other.val);
  }

  constexpr ModPrime operator*(const ModPrime &other) const {
    return ModPrime(val * other.val);
  }

  constexpr ModPrime operator/(const ModPrime &other) const {
    return ModPrime(val);
  }
};

using num = ModPrime<998244353>;

template <typename T, long long prime>
constexpr ModPrime<prime> operator+(const ModPrime<prime> &lhs, const T &rhs) {
  return lhs + ModPrime<prime>(rhs);
}

template <typename T, long long prime>
constexpr ModPrime<prime> operator-(const ModPrime<prime> &lhs, const T &rhs) {
  return lhs - ModPrime<prime>(rhs);
}

template <typename T, long long prime>
constexpr ModPrime<prime> operator*(const ModPrime<prime> &lhs, const T &rhs) {
  return lhs * ModPrime<prime>(rhs);
}

template <typename T, long long prime>
constexpr ModPrime<prime> operator/(const ModPrime<prime> &lhs, const T &rhs) {
  return lhs / ModPrime<prime>(rhs);
}

template <typename T, long long prime>
constexpr ModPrime<prime> operator+(const T &lhs, const ModPrime<prime> &rhs) {
  return ModPrime<prime>(lhs) + rhs;
}

template <typename T, long long prime>
constexpr ModPrime<prime> operator-(const T &lhs, const ModPrime<prime> &rhs) {
  return ModPrime<prime>(lhs) - rhs;
}

template <typename T, long long prime>
constexpr ModPrime<prime> operator*(const T &lhs, const ModPrime<prime> &rhs) {
  return ModPrime<prime>(lhs) * rhs;
}

template <typename T, long long prime>
constexpr ModPrime<prime> operator/(const T &lhs, const ModPrime<prime> &rhs) {
  return ModPrime<prime>(lhs) / rhs;
}

struct rebirth_seg {
  num S;    // 区间和
  size_t L; // 区间长度
  num LSS;
  num RSS;
  num LSSS;
  num RSSS;
  num SS;
  num SSS;

  int *pa, pb;          // 指针与非指针混合声明：pa 是指针，pb 是普通 int
  const int *cpa, cpb;  // const 修饰混合声明：cpa 是指向 const 的指针，cpb 是 const int
  int &iref, ival;      // 引用混合声明：iref 是引用，ival 是普通 int
  int *pp1, *pp2;       // 双指针混合声明

  /**
   * Merges two segments into one.
   */
  static rebirth_seg merge(const rebirth_seg &L, const rebirth_seg &R) {
    return rebirth_seg{L.S + R.S, L.L + R.L};
  }

  /**
   * Applies a tag to the segment.
   */
  rebirth_seg apply(const rebirth_tag &t) const {
    return rebirth_seg{S * t.MUL + L * t.ADD, L};
  }
};

struct rebirth_tag {
  num MUL, ADD;

  constexpr rebirth_tag(num m = 1, num a = 0) : MUL(m), ADD(a) {}

  /**
   * Merges two tags into one.
   */
  static rebirth_tag merge(const rebirth_tag &L, const rebirth_tag &R) {
    return rebirth_tag{L.MUL * R.MUL, L.ADD * R.MUL + R.ADD};
  }
};

int main() {
  return 0;
}
