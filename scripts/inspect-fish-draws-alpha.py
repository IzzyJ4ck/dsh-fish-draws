import argparse
import json
import struct
import zlib
from pathlib import Path


PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"


def paeth(left: int, above: int, upper_left: int) -> int:
    estimate = left + above - upper_left
    distances = (abs(estimate - left), abs(estimate - above), abs(estimate - upper_left))
    if distances[0] <= distances[1] and distances[0] <= distances[2]:
        return left
    if distances[1] <= distances[2]:
        return above
    return upper_left


def read_png(path: Path) -> tuple[int, int, int, bytes | None, bytes]:
    data = path.read_bytes()
    if data[:8] != PNG_SIGNATURE:
        raise ValueError("file is not a PNG")

    width = height = bit_depth = color_type = interlace = None
    transparency = None
    compressed = bytearray()
    offset = 8
    while offset < len(data):
        if offset + 12 > len(data):
            raise ValueError("truncated PNG chunk")
        length = struct.unpack(">I", data[offset : offset + 4])[0]
        chunk_type = data[offset + 4 : offset + 8]
        chunk_data = data[offset + 8 : offset + 8 + length]
        if len(chunk_data) != length:
            raise ValueError("truncated PNG chunk data")
        offset += 12 + length
        if chunk_type == b"IHDR":
            width, height, bit_depth, color_type, compression, filtering, interlace = struct.unpack(
                ">IIBBBBB", chunk_data
            )
            if compression != 0 or filtering != 0:
                raise ValueError("unsupported PNG compression or filter method")
        elif chunk_type == b"tRNS":
            transparency = bytes(chunk_data)
        elif chunk_type == b"IDAT":
            compressed.extend(chunk_data)
        elif chunk_type == b"IEND":
            break

    if None in (width, height, bit_depth, color_type, interlace):
        raise ValueError("PNG is missing IHDR")
    if bit_depth != 8:
        raise ValueError(f"unsupported PNG bit depth: {bit_depth}")
    if interlace != 0:
        raise ValueError("interlaced PNG is not supported by the read-only inspector")
    return width, height, color_type, transparency, zlib.decompress(bytes(compressed))


def alpha_values(
    width: int, height: int, color_type: int, transparency: bytes | None, raw: bytes
) -> tuple[str, bytearray | None]:
    channels_by_type = {0: 1, 2: 3, 3: 1, 4: 2, 6: 4}
    if color_type not in channels_by_type:
        raise ValueError(f"unsupported PNG color type: {color_type}")
    channels = channels_by_type[color_type]
    stride = width * channels
    expected = height * (stride + 1)
    if len(raw) != expected:
        raise ValueError(f"unexpected decompressed PNG size: expected {expected}, got {len(raw)}")

    previous = bytearray(stride)
    alphas = bytearray()
    offset = 0
    for _ in range(height):
        filter_type = raw[offset]
        offset += 1
        encoded = raw[offset : offset + stride]
        offset += stride
        reconstructed = bytearray(stride)
        for index, value in enumerate(encoded):
            left = reconstructed[index - channels] if index >= channels else 0
            above = previous[index]
            upper_left = previous[index - channels] if index >= channels else 0
            if filter_type == 0:
                predictor = 0
            elif filter_type == 1:
                predictor = left
            elif filter_type == 2:
                predictor = above
            elif filter_type == 3:
                predictor = (left + above) // 2
            elif filter_type == 4:
                predictor = paeth(left, above, upper_left)
            else:
                raise ValueError(f"unsupported PNG row filter: {filter_type}")
            reconstructed[index] = (value + predictor) & 0xFF

        if color_type == 6:
            alphas.extend(reconstructed[3::4])
        elif color_type == 4:
            alphas.extend(reconstructed[1::2])
        elif color_type == 3 and transparency is not None:
            alphas.extend(transparency[index] if index < len(transparency) else 255 for index in reconstructed)
        previous = reconstructed

    mode = {0: "L", 2: "RGB", 3: "P", 4: "LA", 6: "RGBA"}[color_type]
    return mode, alphas if alphas else None


def main() -> int:
    parser = argparse.ArgumentParser(description="Read-only alpha inspection for fish-draws PNG outputs.")
    parser.add_argument("image")
    parser.add_argument("--near-transparent-threshold", type=int, default=25)
    args = parser.parse_args()

    threshold = args.near_transparent_threshold
    if threshold < 0 or threshold > 254:
        raise SystemExit("near-transparent threshold must be between 0 and 254")

    path = Path(args.image).resolve()
    if not path.is_file():
        raise SystemExit(f"image not found: {path}")

    try:
        width, height, color_type, transparency, raw = read_png(path)
        mode, alphas = alpha_values(width, height, color_type, transparency, raw)
    except (OSError, ValueError, zlib.error) as error:
        raise SystemExit(str(error)) from error

    result = {
        "ok": True,
        "path": str(path).replace("\\", "/"),
        "mode": mode,
        "width": width,
        "height": height,
        "has_alpha": alphas is not None,
        "near_transparent_threshold": threshold,
    }
    if alphas is None:
        result["alpha_status"] = "absent"
    else:
        total = len(alphas)
        corners = [alphas[0], alphas[width - 1], alphas[(height - 1) * width], alphas[-1]]
        minimum = min(alphas)
        result.update(
            {
                "alpha_status": "opaque" if minimum > threshold else "contains_transparency",
                "alpha_min": minimum,
                "alpha_max": max(alphas),
                "fully_transparent_fraction": sum(value == 0 for value in alphas) / total,
                "near_transparent_fraction": sum(value <= threshold for value in alphas) / total,
                "opaque_fraction": sum(value == 255 for value in alphas) / total,
                "corner_alpha": corners,
                "corners_near_transparent": all(value <= threshold for value in corners),
            }
        )

    print(json.dumps(result, ensure_ascii=False, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
