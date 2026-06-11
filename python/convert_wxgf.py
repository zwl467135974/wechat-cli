import struct
import sys
import os

def find_hevc_start(data):
    for i in range(len(data) - 5):
        if data[i:i+4] == b'\x00\x00\x00\x01':
            nalu_type = (data[i+4] >> 1) & 0x3f
            if nalu_type in (32, 33, 34, 19, 20):
                return i
    for i in range(len(data) - 5):
        if data[i:i+4] == b'\x00\x00\x00\x01' or data[i:i+3] == b'\x00\x00\x01':
            return i
    return None

def convert_wxgf_to_jpg(dat_path):
    import av
    
    with open(dat_path, 'rb') as f:
        data = f.read()
    
    hevc_offset = find_hevc_start(data)
    if hevc_offset is None:
        return None
    
    hevc_data = data[hevc_offset:]
    
    tmp_265 = dat_path + '.tmp.265'
    with open(tmp_265, 'wb') as f:
        f.write(hevc_data)
    
    try:
        container = av.open(tmp_265)
        for frame in container.decode(video=0):
            from io import BytesIO
            buf = BytesIO()
            frame.to_image().save(buf, 'JPEG', quality=90)
            container.close()
            return buf.getvalue()
        container.close()
    except Exception:
        pass
    finally:
        if os.path.exists(tmp_265):
            os.remove(tmp_265)
    
    return None

if __name__ == '__main__':
    if len(sys.argv) < 3:
        print('Usage: python convert_wxgf.py <dat_path> <output_path>', file=sys.stderr)
        sys.exit(1)
    
    dat_path = sys.argv[1]
    out_path = sys.argv[2]
    
    result = convert_wxgf_to_jpg(dat_path)
    if result:
        with open(out_path, 'wb') as f:
            f.write(result)
    else:
        print('Conversion failed', file=sys.stderr)
        sys.exit(1)
