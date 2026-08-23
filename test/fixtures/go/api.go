package main

// Reader 读取器接口
type Reader interface {
	// Read 读取数据
	Read() string
}

// FileReader 文件读取器
type FileReader struct {
	// Path 文件路径
	Path string
}

// Read 读取文件内容
func (f *FileReader) Read() string {
	return f.Path
}
